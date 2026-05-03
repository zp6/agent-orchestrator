import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import type { Hex } from "viem";
import { TreasuryClient, AAVE_V3_POOL_BASE, USDC_BASE, USDC_POLYGON, TREASURY_ADDRESS, MORPHO_STEAKHOUSE_USDC, USDC_DECIMALS, CCTP_TOKEN_MESSENGER_BASE, CCTP_MESSAGE_TRANSMITTER_POLYGON, POLYMARKET_CTF_EXCHANGE, LIFI_DIAMOND_BASE, POLYGON_NATIVE_MATIC } from "../../services/treasury.js";
import { PolymarketClient } from "../../services/polymarket-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROOF_OF_LIFE_MAX_USD = 50;

function formatUsdc(units: bigint): string {
  const divisor = 10n ** BigInt(USDC_DECIMALS);
  const whole = units / divisor;
  const frac = units % divisor;
  return `${whole}.${frac.toString().padStart(USDC_DECIMALS, "0")}`;
}

export function registerTreasuryCommand(program: Command): void {
  const treasury = program.command("treasury").description("Fleet treasury operations (signer-gated)");

  treasury
    .command("balance")
    .description("Show treasury USDC balance and Aave allowance on Base")
    .action(async () => {
      const client = new TreasuryClient();
      const [balance, allowance] = await Promise.all([
        client.treasuryUsdcBalance(),
        client.treasuryAaveAllowance(),
      ]);
      console.log(`Treasury: ${TREASURY_ADDRESS}`);
      console.log(`USDC balance: ${formatUsdc(balance)} USDC`);
      console.log(`Aave allowance: ${formatUsdc(allowance)} USDC`);
    });

  treasury
    .command("aave-supply")
    .description("Supply USDC to Aave V3 on Base via the signer (proof-of-life capped to $5)")
    .requiredOption("--amount <usd>", "Amount to supply, in USD (USDC = 1:1). Capped at $5 in this command.")
    .option("--skip-approve", "Skip the ERC20 approve step (use only if allowance is already sufficient)")
    .action(async (opts: { amount: string; skipApprove?: boolean }) => {
      const usd = Number(opts.amount);
      if (!Number.isFinite(usd) || usd <= 0) {
        console.error(chalk.red("--amount must be a positive number"));
        process.exit(1);
      }
      if (usd > PROOF_OF_LIFE_MAX_USD) {
        console.error(
          chalk.red(`--amount is capped at $${PROOF_OF_LIFE_MAX_USD} for this proof-of-life command`),
        );
        process.exit(1);
      }

      const client = new TreasuryClient();
      const amountUnits = BigInt(Math.round(usd * 10 ** USDC_DECIMALS));

      console.log(chalk.dim("Pre-flight: checking signer + treasury balance"));
      const [balance, allowance] = await Promise.all([
        client.treasuryUsdcBalance(),
        client.treasuryAaveAllowance(),
      ]);
      console.log(`  USDC balance:   ${formatUsdc(balance)} USDC`);
      console.log(`  Aave allowance: ${formatUsdc(allowance)} USDC`);
      if (balance < amountUnits) {
        console.error(chalk.red(`Insufficient balance: need ${formatUsdc(amountUnits)}, have ${formatUsdc(balance)}`));
        process.exit(1);
      }

      if (!opts.skipApprove && allowance < amountUnits) {
        console.log(chalk.cyan("\nStep 1/2: ERC20 approve USDC → Aave V3 Pool"));
        const approveReceipt = await client.signAndBroadcast({
          operation: "erc20_approve_usdc",
          to: USDC_BASE,
          data: client.buildApproveCalldata(amountUnits),
          usdValue: usd,
        });
        console.log(chalk.green(`  ✓ approve confirmed: ${approveReceipt.transactionHash}`));
        // Brief wait for RPC nodes to sync the new allowance before estimating supply gas
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        console.log(chalk.dim("Skipping approve (allowance already sufficient)"));
      }

      console.log(chalk.cyan("\nStep 2/2: Aave V3 supply()"));
      const supplyReceipt = await client.signAndBroadcast({
        operation: "aave_supply_usdc",
        to: AAVE_V3_POOL_BASE,
        data: client.buildSupplyCalldata(amountUnits),
        usdValue: usd,
      });
      console.log(chalk.green(`  ✓ supply confirmed: ${supplyReceipt.transactionHash}`));
      console.log(`\nBasescan: https://basescan.org/tx/${supplyReceipt.transactionHash}`);
      console.log(`Treasury position: https://basescan.org/address/${TREASURY_ADDRESS}#tokentxns`);
    });

  treasury
    .command("morpho-migrate")
    .description("Migrate USDC from Aave V3 to Morpho Steakhouse vault on Base (higher APY)")
    .requiredOption("--amount <usd>", "Amount to migrate in USD. Use 'all' to migrate full Aave position.")
    .action(async (opts: { amount: string }) => {
      const client = new TreasuryClient();

      console.log(chalk.dim("Pre-flight: reading balances..."));
      const [liquidBalance, aaveBalance, morphoBalance] = await Promise.all([
        client.treasuryUsdcBalance(),
        client.treasuryAaveUsdcBalance(),
        client.treasuryMorphoUsdcBalance(),
      ]);
      console.log(`  Liquid USDC:  ${formatUsdc(liquidBalance)} USDC`);
      console.log(`  Aave aUSDC:   ${formatUsdc(aaveBalance)} USDC`);
      console.log(`  Morpho USDC:  ${formatUsdc(morphoBalance)} USDC`);

      const amountUnits = opts.amount === "all"
        ? (aaveBalance > 0n ? aaveBalance : liquidBalance)
        : BigInt(Math.round(Number(opts.amount) * 10 ** USDC_DECIMALS));

      if (amountUnits <= 0n) {
        console.error(chalk.red("No balance to migrate"));
        process.exit(1);
      }

      const usd = Number(amountUnits) / 10 ** USDC_DECIMALS;
      if (usd > 50) {
        console.error(chalk.red("Per-tx cap is $50. Split into multiple transactions."));
        process.exit(1);
      }

      let stepNum = 1;
      const totalSteps = aaveBalance >= amountUnits ? 3 : 2;

      if (aaveBalance >= amountUnits) {
        console.log(chalk.cyan(`\nStep ${stepNum++}/${totalSteps}: Aave withdraw ${formatUsdc(amountUnits)} USDC`));
        const withdrawReceipt = await client.signAndBroadcast({
          operation: "aave_withdraw",
          to: AAVE_V3_POOL_BASE,
          data: client.buildWithdrawCalldata(amountUnits),
          usdValue: usd,
        });
        console.log(chalk.green(`  ✓ withdraw confirmed: ${withdrawReceipt.transactionHash}`));
        await new Promise((r) => setTimeout(r, 3000));
      } else if (liquidBalance < amountUnits) {
        console.error(chalk.red(`Insufficient balance: need ${formatUsdc(amountUnits)}, liquid ${formatUsdc(liquidBalance)}, aave ${formatUsdc(aaveBalance)}`));
        process.exit(1);
      } else {
        console.log(chalk.dim("Using liquid USDC (Aave already withdrawn)"));
      }

      console.log(chalk.cyan(`\nStep ${stepNum++}/${totalSteps}: Approve USDC → Morpho vault`));
      const approveReceipt = await client.signAndBroadcast({
        operation: "erc20_approve_usdc",
        to: USDC_BASE,
        data: client.buildApproveMorphoCalldata(amountUnits),
        usdValue: usd,
      });
      console.log(chalk.green(`  ✓ approve confirmed: ${approveReceipt.transactionHash}`));
      await new Promise((r) => setTimeout(r, 3000));

      console.log(chalk.cyan(`\nStep ${stepNum}/${totalSteps}: Morpho deposit`));
      const depositReceipt = await client.signAndBroadcast({
        operation: "morpho_deposit",
        to: MORPHO_STEAKHOUSE_USDC,
        data: client.buildMorphoDepositCalldata(amountUnits),
        usdValue: usd,
      });
      console.log(chalk.green(`  ✓ deposit confirmed: ${depositReceipt.transactionHash}`));
      console.log(`\nBasescan: https://basescan.org/tx/${depositReceipt.transactionHash}`);
      console.log(chalk.green(`\nMigration complete. Capital now earning ~4.5-7.5% APY in Morpho Steakhouse USDC.`));
    });

  treasury
    .command("arb-deploy")
    .description("Deploy FlashArbBot contract to Base (one-time, ~$0.05 gas)")
    .action(async () => {
      const artifactPath = join(__dirname, "../../../contracts/FlashArbBot.json");
      let bytecode: Hex;
      try {
        ({ bytecode } = JSON.parse(readFileSync(artifactPath, "utf8")) as { bytecode: Hex });
      } catch {
        console.error(chalk.red(`FlashArbBot.json not found at ${artifactPath}`));
        console.error(chalk.red("Compile first: run the compile script in contracts/"));
        process.exit(1);
      }

      const client = new TreasuryClient();
      const deployData = client.buildFlashArbBotDeployData(bytecode);

      console.log(chalk.dim("Deploying FlashArbBot to Base..."));
      console.log(`  Aave pool: ${AAVE_V3_POOL_BASE}`);
      console.log(`  Owner (treasury): ${TREASURY_ADDRESS}`);
      console.log(`  Bytecode bytes: ${(deployData.length - 2) / 2}`);

      const receipt = await client.signAndBroadcast({
        operation: "deploy_flash_arb_bot",
        to: null,
        data: deployData,
        usdValue: 0.05,
      });

      const contractAddress = receipt.contractAddress;
      console.log(chalk.green(`\n  ✓ FlashArbBot deployed: ${contractAddress}`));
      console.log(`  Tx: ${receipt.transactionHash}`);
      console.log(`\nBasescan: https://basescan.org/address/${contractAddress}`);
      console.log(chalk.cyan(`\nSave this address — set FLASH_ARB_BOT_ADDRESS=${contractAddress} in .env`));
    });

  treasury
    .command("polymarket-fund")
    .description("Withdraw from Morpho, seed MATIC on Polygon, bridge USDC to Polygon — fully autonomous via Li.fi")
    .option("--amount <usd>", "Total USDC to move to Polygon (default: 32)", "32")
    .option("--gas-seed <usd>", "Amount of USDC to convert to MATIC for Polygon gas (default: 2)", "2")
    .action(async (opts: { amount: string; gasSeed: string }) => {
      const totalUsd = Number(opts.amount);
      const gasSeedUsd = Number(opts.gasSeed);
      if (!Number.isFinite(totalUsd) || totalUsd <= 0 || totalUsd > 50) {
        console.error(chalk.red("--amount must be 0–50")); process.exit(1);
      }
      if (!Number.isFinite(gasSeedUsd) || gasSeedUsd <= 0 || gasSeedUsd >= totalUsd) {
        console.error(chalk.red("--gas-seed must be positive and less than --amount")); process.exit(1);
      }

      const client = new TreasuryClient();
      const totalUnits = BigInt(Math.round(totalUsd * 10 ** USDC_DECIMALS));
      const gasSeedUnits = BigInt(Math.round(gasSeedUsd * 10 ** USDC_DECIMALS));
      const bridgeUnits = totalUnits - gasSeedUnits;
      const bridgeUsd = totalUsd - gasSeedUsd;

      console.log(chalk.bold("\nPolymarket Fund — autonomous Li.fi path"));
      console.log(`  Total: $${totalUsd}  |  Gas seed: $${gasSeedUsd} → MATIC  |  USDC bridge: $${bridgeUsd}`);
      console.log(chalk.dim("(Li.fi auto-delivers on Polygon — no MATIC needed to receive)\n"));

      // Step 1: withdraw from Morpho
      console.log(chalk.dim("Pre-flight: reading Morpho balance..."));
      const [morphoShares, morphoUsdc, liquidUsdc] = await Promise.all([
        client.treasuryMorphoShares(),
        client.treasuryMorphoUsdcBalance(),
        client.treasuryUsdcBalance(),
      ]);
      console.log(`  Morpho: ${formatUsdc(morphoUsdc)} USDC (${morphoShares} shares)`);
      console.log(`  Liquid: ${formatUsdc(liquidUsdc)} USDC`);

      let liquidAfterWithdraw = liquidUsdc;
      if (liquidUsdc < totalUnits) {
        const shortfall = totalUnits - liquidUsdc;
        if (morphoUsdc < shortfall) {
          console.error(chalk.red(`Insufficient funds: need $${totalUsd}, have $${Number(liquidUsdc + morphoUsdc) / 1e6}`));
          process.exit(1);
        }
        // Redeem enough shares to cover the shortfall (redeem proportional shares)
        const sharesToRedeem = (morphoShares * shortfall) / morphoUsdc + 1n;
        console.log(chalk.cyan(`\nStep 1/5: Redeem ${formatUsdc(shortfall)} USDC from Morpho`));
        const redeemReceipt = await client.signAndBroadcast({
          operation: "morpho_withdraw",
          to: MORPHO_STEAKHOUSE_USDC,
          data: client.buildMorphoRedeemCalldata(sharesToRedeem),
          usdValue: Number(shortfall) / 1e6,
        });
        console.log(chalk.green(`  ✓ redeemed: ${redeemReceipt.transactionHash}`));
        await new Promise(r => setTimeout(r, 4000));
        liquidAfterWithdraw = await client.treasuryUsdcBalance();
        console.log(`  Liquid USDC now: ${formatUsdc(liquidAfterWithdraw)}`);
      } else {
        console.log(chalk.dim("Step 1/5: Sufficient liquid USDC, skipping Morpho redeem"));
      }

      if (liquidAfterWithdraw < totalUnits) {
        console.error(chalk.red(`Still insufficient after redeem: ${formatUsdc(liquidAfterWithdraw)}`));
        process.exit(1);
      }

      // Step 2: Approve Li.fi for gas seed
      console.log(chalk.cyan(`\nStep 2/5: Approve USDC $${gasSeedUsd} → Li.fi Diamond (gas seed)`));
      const approveGas = await client.signAndBroadcast({
        operation: "erc20_approve_usdc",
        to: USDC_BASE,
        data: client.buildApproveCalldataForSpender(LIFI_DIAMOND_BASE, gasSeedUnits),
        usdValue: gasSeedUsd,
      });
      console.log(chalk.green(`  ✓ approve: ${approveGas.transactionHash}`));
      await new Promise(r => setTimeout(r, 3000));

      // Step 3: Bridge USDC → MATIC on Polygon (gas seed)
      console.log(chalk.cyan(`\nStep 3/5: Bridge $${gasSeedUsd} USDC → MATIC on Polygon (via Li.fi)`));
      const maticQuote = await client.fetchLifiBridgeQuote({ fromAmountUsdc: gasSeedUsd, toToken: POLYGON_NATIVE_MATIC });
      const maticReceived = Number(maticQuote.estimatedOutput) / 1e18;
      console.log(`  Bridge: ${maticQuote.toolName} | ~${maticReceived.toFixed(2)} MATIC to ${TREASURY_ADDRESS}`);
      const maticBridgeReceipt = await client.signAndBroadcast({
        operation: "lifi_bridge",
        to: LIFI_DIAMOND_BASE,
        data: maticQuote.data,
        usdValue: gasSeedUsd,
      });
      console.log(chalk.green(`  ✓ MATIC bridge submitted: ${maticBridgeReceipt.transactionHash}`));
      console.log(chalk.dim(`  Li.fi auto-delivers MATIC to Polygon (no manual claim needed)`));
      await new Promise(r => setTimeout(r, 4000));

      // Step 4: Approve Li.fi for USDC bridge
      console.log(chalk.cyan(`\nStep 4/5: Approve USDC $${bridgeUsd} → Li.fi Diamond (USDC bridge)`));
      const approveUsdc = await client.signAndBroadcast({
        operation: "erc20_approve_usdc",
        to: USDC_BASE,
        data: client.buildApproveCalldataForSpender(LIFI_DIAMOND_BASE, bridgeUnits),
        usdValue: bridgeUsd,
      });
      console.log(chalk.green(`  ✓ approve: ${approveUsdc.transactionHash}`));
      await new Promise(r => setTimeout(r, 3000));

      // Step 5: Bridge USDC → USDC on Polygon
      console.log(chalk.cyan(`\nStep 5/5: Bridge $${bridgeUsd} USDC Base → USDC Polygon (via Li.fi)`));
      const usdcQuote = await client.fetchLifiBridgeQuote({ fromAmountUsdc: bridgeUsd, toToken: USDC_POLYGON });
      const usdcReceived = Number(usdcQuote.estimatedOutput) / 1e6;
      console.log(`  Bridge: ${usdcQuote.toolName} | ~$${usdcReceived.toFixed(2)} USDC to ${TREASURY_ADDRESS}`);
      const usdcBridgeReceipt = await client.signAndBroadcast({
        operation: "lifi_bridge",
        to: LIFI_DIAMOND_BASE,
        data: usdcQuote.data,
        usdValue: bridgeUsd,
      });
      console.log(chalk.green(`  ✓ USDC bridge submitted: ${usdcBridgeReceipt.transactionHash}`));

      console.log(chalk.bold.green(`\n✓ Polymarket funding complete!`));
      console.log(`  ~${maticReceived.toFixed(2)} MATIC + ~$${usdcReceived.toFixed(2)} USDC landing on Polygon (Li.fi delivers in ~1–5 min)`);
      console.log(chalk.cyan(`\nNext: orch treasury polymarket-bet --market <slug> --side no --amount 25 --price 0.54`));
    });

  treasury
    .command("polymarket-bridge")
    .description("Bridge USDC from Base to Polygon via CCTP (for Polymarket betting)")
    .requiredOption("--amount <usd>", "Amount in USD to bridge (max $50)")
    .action(async (opts: { amount: string }) => {
      const usd = Number(opts.amount);
      if (!Number.isFinite(usd) || usd <= 0 || usd > 50) {
        console.error(chalk.red("--amount must be 0–50"));
        process.exit(1);
      }

      const client = new TreasuryClient();
      const amountUnits = BigInt(Math.round(usd * 10 ** USDC_DECIMALS));

      console.log(chalk.dim("Pre-flight: checking balances..."));
      const [baseBalance, polygonBalance] = await Promise.all([
        client.treasuryUsdcBalance(),
        client.treasuryPolygonUsdcBalance(),
      ]);
      console.log(`  Base USDC:    ${formatUsdc(baseBalance)}`);
      console.log(`  Polygon USDC: ${formatUsdc(polygonBalance)}`);
      if (baseBalance < amountUnits) {
        console.error(chalk.red(`Insufficient Base USDC: need ${formatUsdc(amountUnits)}, have ${formatUsdc(baseBalance)}`));
        process.exit(1);
      }

      console.log(chalk.yellow(`\n⚠  Treasury needs MATIC on Polygon for gas to receive the bridge.`));
      console.log(chalk.yellow(`   Send ~$2 MATIC to ${TREASURY_ADDRESS} on Polygon if not already funded.`));

      console.log(chalk.cyan("\nStep 1/3: Approve USDC → CCTP TokenMessenger on Base"));
      const approveReceipt = await client.signAndBroadcast({
        operation: "erc20_approve_usdc",
        to: USDC_BASE,
        data: client.buildCctpApproveCalldata(amountUnits),
        usdValue: usd,
      });
      console.log(chalk.green(`  ✓ approve: ${approveReceipt.transactionHash}`));
      await new Promise(r => setTimeout(r, 3000));

      console.log(chalk.cyan("\nStep 2/3: depositForBurn (CCTP bridge Base → Polygon)"));
      const burnReceipt = await client.signAndBroadcast({
        operation: "bridge_usdc_to_polygon",
        to: CCTP_TOKEN_MESSENGER_BASE,
        data: client.buildCctpDepositForBurnCalldata(amountUnits),
        usdValue: usd,
      });
      console.log(chalk.green(`  ✓ burn tx: ${burnReceipt.transactionHash}`));
      console.log(chalk.dim(`  Polling Circle attestation API (~2–10 min)...`));

      const { message, attestation } = await client.pollCctpAttestation(burnReceipt.transactionHash);
      console.log(chalk.green(`  ✓ attestation ready`));

      console.log(chalk.cyan("\nStep 3/3: receiveMessage on Polygon"));
      const receiveReceipt = await client.signAndBroadcastPolygon({
        operation: "cctp_receive_message",
        to: CCTP_MESSAGE_TRANSMITTER_POLYGON,
        data: client.buildCctpReceiveMessageCalldata(message, attestation),
        usdValue: 0,
      });
      console.log(chalk.green(`  ✓ USDC received on Polygon: ${receiveReceipt.transactionHash}`));
      console.log(`\nPolygonscan: https://polygonscan.com/tx/${receiveReceipt.transactionHash}`);

      const newBalance = await client.treasuryPolygonUsdcBalance();
      console.log(chalk.green(`\nPolygon treasury USDC: ${formatUsdc(newBalance)}`));
    });

  treasury
    .command("polymarket-bet")
    .description("Place a Polymarket CLOB order (sign + submit off-chain)")
    .requiredOption("--market <slug>", "Market slug from Polymarket URL (e.g. gemini-3pt5-released-by)")
    .requiredOption("--side <yes|no>", "YES or NO outcome")
    .requiredOption("--amount <usd>", "USDC amount to stake (max $50)")
    .requiredOption("--price <0-1>", "Max price per token (0–1). E.g. 0.53 = 53¢ per token")
    .option("--skip-approve", "Skip USDC approve to CTF Exchange (if already approved)")
    .action(async (opts: { market: string; side: string; amount: string; price: string; skipApprove?: boolean }) => {
      const side = opts.side.toLowerCase();
      if (side !== "yes" && side !== "no") {
        console.error(chalk.red("--side must be 'yes' or 'no'"));
        process.exit(1);
      }
      const usd = Number(opts.amount);
      const price = Number(opts.price);
      if (!Number.isFinite(usd) || usd <= 0 || usd > 50) {
        console.error(chalk.red("--amount must be 0–50"));
        process.exit(1);
      }
      if (!Number.isFinite(price) || price <= 0 || price >= 1) {
        console.error(chalk.red("--price must be between 0 and 1"));
        process.exit(1);
      }

      const client = new TreasuryClient();
      const polymarket = new PolymarketClient(client.signerClient);

      console.log(chalk.dim(`Fetching market: ${opts.market}`));
      const market = await polymarket.getMarket(opts.market);
      console.log(`  ${market.question}`);
      console.log(`  YES: ${(market.yesPrice * 100).toFixed(1)}¢  NO: ${(market.noPrice * 100).toFixed(1)}¢`);

      const tokenId = side === "yes" ? market.yesTokenId : market.noTokenId;
      const currentPrice = side === "yes" ? market.yesPrice : market.noPrice;
      if (currentPrice > price) {
        console.log(chalk.yellow(`  ⚠  Current ${side.toUpperCase()} price (${(currentPrice * 100).toFixed(1)}¢) > your limit (${(price * 100).toFixed(1)}¢)`));
        console.log(chalk.yellow(`     Order will rest on the book until filled.`));
      }

      const amountUnits = BigInt(Math.round(usd * 10 ** USDC_DECIMALS));

      if (!opts.skipApprove) {
        console.log(chalk.cyan("\nStep 1/2: Approve USDC → Polymarket CTF Exchange on Polygon"));
        console.log(chalk.yellow(`  ⚠  Needs MATIC on Polygon for gas. Treasury: ${TREASURY_ADDRESS}`));
        const approveReceipt = await client.signAndBroadcastPolygon({
          operation: "erc20_approve_usdc_polygon",
          to: USDC_POLYGON,
          data: client.buildPolygonUsdcApproveCalldata(POLYMARKET_CTF_EXCHANGE, amountUnits),
          usdValue: usd,
        });
        console.log(chalk.green(`  ✓ approve: ${approveReceipt.transactionHash}`));
      }

      console.log(chalk.cyan("\nStep 2/2: Authenticate + submit CLOB order"));
      await polymarket.authenticate(TREASURY_ADDRESS);
      const orderId = await polymarket.placeOrder({ tokenId, side: "BUY", amountUsdc: usd, price });
      console.log(chalk.green(`\n  ✓ Order submitted: ${orderId}`));
      console.log(`  Market: ${market.question}`);
      console.log(`  Bet:    $${usd} ${side.toUpperCase()} @ ${(price * 100).toFixed(1)}¢`);
      console.log(`  Expected payout if correct: $${(usd / price).toFixed(2)}`);
      console.log(`\nPolymarket: https://polymarket.com/event/${opts.market}`);
    });
}
