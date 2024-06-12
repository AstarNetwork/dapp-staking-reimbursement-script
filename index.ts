import { setupContext } from "@acala-network/chopsticks-utils";
import { overrideStorage } from "@acala-network/chopsticks/utils/override";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { hexToBigInt } from "@polkadot/util";

const START_BLOCK = 6216237; // runtime upgrade with the issue
const END_BLOCK = 6285334; // runtime upgrade with the fix

// use a healthy one
const ENDPOINT = "wss://rpc.astar.network";

const replacer = (_k: string, v: any) =>
  typeof v === "bigint" ? v.toString() : v;

type Reward = { reward: bigint; tierId: number; beneficiary: string };

async function main() {
  const api = await ApiPromise.create({
    provider: new WsProvider(ENDPOINT),
  });

  const blockHash = async (number: number) =>
    api.rpc.chain.getBlockHash(number);

  const ensureHasEvent = (events: any) => {
    for (const event of events) {
      if (
        event.event.section === "dappStaking" &&
        event.event.method === "NewEra"
      ) {
        return;
      }
    }
    throw new Error("Missing dappStaking::NewEra event");
  };

  let apiAt = await api.at(await blockHash(START_BLOCK));
  let protocolState = await apiAt.query.dappStaking.activeProtocolState<any>();

  // map of era and block number
  let blocks: Map<number, number> = new Map();

  let actualTiers: Map<number, Map<number, Reward>> = new Map();

  // iterate eras affected by the bug and query data
  do {
    const blockNo = protocolState.nextEraStart.toNumber();
    const era = protocolState.era.toNumber();
    blocks.set(era, blockNo);

    console.log(`Query ${blockNo} for era: ${era}`);

    // move to next era bump when tier is calculated
    apiAt = await api.at(await blockHash(blockNo));
    // ensure era bump event is emitted
    ensureHasEvent((await apiAt.query.system.events()).toHuman());

    // extract new calculated reward
    {
      const { dapps, rewards } = (
        await apiAt.query.dappStaking.dAppTiers<any>(era)
      ).toJSON();
      const integratedDApps = (
        await apiAt.query.dappStaking.integratedDApps.entries()
      ).map(([_, value]) => value.toJSON() as any);

      const dappsReward = new Map();
      for (const [dappId, tierId] of Object.entries(dapps)) {
        const reward = hexToBigInt(rewards[tierId as number]);
        const dapp = integratedDApps.find((x) => x.id === Number(dappId));
        if (!dapp) throw new Error("dapp should exists");
        dappsReward.set(Number(dappId), {
          reward,
          tierId,
          beneficiary: dapp.rewardBeneficiary || dapp.owner,
        });
      }
      actualTiers.set(era, dappsReward);
    }

    protocolState = await apiAt.query.dappStaking.activeProtocolState<any>();
  } while (protocolState.nextEraStart.toNumber() < END_BLOCK);

  // block which contains runtime with the fix
  const runtime = (
    await (await api.at(await blockHash(END_BLOCK))).query.substrate.code()
  ).toHex();

  await api.disconnect();

  /************************/
  /** recalculate section using chopsticks */
  /************************/

  let tierConfig: string | undefined;

  // replay blocks with new runtime
  const expectedTiers: Map<number, Map<number, Reward>> = new Map();
  for (const [era, block] of blocks) {
    console.log(`Replay ${block} for era: ${era}`);

    // setup chopsticks one block prior to era bump/reward calculation
    const ctx = await setupContext({
      endpoint: ENDPOINT,
      blockNumber: block - 1,
      db: "cache.sqlite",
      timeout: 1_000_000,
    });
    // override runtime with the fix
    ctx.chain.head.setWasm(runtime);

    if (tierConfig) {
      // override tier config from previous adjusment
      await overrideStorage(ctx.chain, { dappStaking: { tierConfig } });
    }

    // build the new block to calculate reward
    await ctx.dev.newBlock();
    // ensure era bump event is emitted
    ensureHasEvent((await ctx.api.query.system.events()).toHuman());

    // read TierConfig for next era calculation
    tierConfig = (await ctx.api.query.dappStaking.tierConfig()).toHex();

    // extract new calculated reward
    {
      const { dapps, rewards } = (
        await ctx.api.query.dappStaking.dAppTiers<any>(era)
      ).toJSON();
      const integratedDApps = (
        await ctx.api.query.dappStaking.integratedDApps.entries()
      ).map(([_, value]) => value.toJSON() as any);

      const dappsReward = new Map();
      for (const [dappId, tierId] of Object.entries(dapps)) {
        const reward = hexToBigInt(rewards[tierId as number]);
        const dapp = integratedDApps.find((x) => x.id === Number(dappId));
        if (!dapp) throw new Error("dapp should exists");
        dappsReward.set(Number(dappId), {
          reward,
          tierId,
          beneficiary: dapp.rewardBeneficiary || dapp.owner,
        });
      }
      expectedTiers.set(era, dappsReward);
    }
    await new Promise((r) => setTimeout(r, 1_000));
    // teardown chopsticks
    await ctx.teardown();
  }

  // merge results
  let finalResults = [];
  for (const [era, dapps] of expectedTiers) {
    for (const [dapp_id, expected] of dapps) {
      const actual = actualTiers.get(era)!.get(dapp_id)!;
      const delta = expected.reward - actual.reward;
      if (delta < 0) {
        throw new Error("amount delta should not be negative");
      }
      finalResults.push({
        era,
        dapp_id,
        beneficiary: expected.beneficiary,
        expected_tier: expected.tierId,
        actual_tier: actual.tierId,
        expected_reward: expected.reward,
        actual_reward: actual.reward,
        delta,
      });
    }
  }

  await Bun.write(
    "./raw-result.json",
    JSON.stringify(finalResults, replacer, 2),
  );

  // extract result csv
  {
    let table = [
      "era,dapp_id,beneficiary,expected_tier,actual_tier,expected_reward,actual_reward,delta",
    ];
    for (
      const {
        era,
        dapp_id,
        beneficiary,
        expected_tier,
        actual_tier,
        expected_reward,
        actual_reward,
        delta,
      } of finalResults
    ) {
      table.push(
        [
          era,
          dapp_id,
          beneficiary,
          expected_tier,
          actual_tier,
          expected_reward,
          actual_reward,
          delta,
        ].join(","),
      );
    }
    await Bun.write("./raw-result.csv", table.join("\n"));
  }

  const reimburse = finalResults
    .filter(({ delta }) => delta !== 0n)
    .reduce<Record<string, bigint>>((acc, x) => {
      const amount = acc[x.beneficiary] || 0n;
      acc[x.beneficiary] = amount + x.delta;
      return acc;
    }, {});

  await Bun.write("./reimburse.json", JSON.stringify(reimburse, replacer, 2));

  // write csv
  {
    let table = ["beneficiary,amount"];
    for (const [beneficiary, amount] of Object.entries(reimburse)) {
      table.push([beneficiary, amount].join(","));
    }
    await Bun.write("./reimburse.csv", table.join("\n"));
  }

  console.log(
    "Total reimbursement amount",
    Object.values(reimburse).reduce((acc, amount) => acc + amount, 0n) /
      10n ** 18n,
    "ASTR",
  );
}

main()
  .then(() => process.exit())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
