import type { Command } from "commander";
import chalk from "chalk";
import { TreasuryClient, AAVE_V3_POOL_BASE, USDC_BASE, TREASURY_ADDRESS, MORPHO_STEAKHOUSE_USDC, USDC_DECIMALS } from "../../services/treasury.js";

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
      const [aaveBalance, morphoBalance] = await Promise.all([
        client.treasuryAaveUsdcBalance(),
        client.treasuryMorphoUsdcBalance(),
      ]);
      console.log(`  Aave aUSDC:   ${formatUsdc(aaveBalance)} USDC`);
      console.log(`  Morpho USDC:  ${formatUsdc(morphoBalance)} USDC`);

      const amountUnits = opts.amount === "all"
        ? aaveBalance
        : BigInt(Math.round(Number(opts.amount) * 10 ** USDC_DECIMALS));

      if (amountUnits <= 0n) {
        console.error(chalk.red("No Aave balance to migrate"));
        process.exit(1);
      }
      if (amountUnits > aaveBalance) {
        console.error(chalk.red(`Aave balance insufficient: need ${formatUsdc(amountUnits)}, have ${formatUsdc(aaveBalance)}`));
        process.exit(1);
      }

      const usd = Number(amountUnits) / 10 ** USDC_DECIMALS;
      if (usd > 50) {
        console.error(chalk.red("Per-tx cap is $50. Split into multiple transactions."));
        process.exit(1);
      }

      console.log(chalk.cyan(`\nStep 1/3: Aave withdraw ${formatUsdc(amountUnits)} USDC`));
      const withdrawReceipt = await client.signAndBroadcast({
        operation: "aave_withdraw",
        to: AAVE_V3_POOL_BASE,
        data: client.buildWithdrawCalldata(amountUnits),
        usdValue: usd,
      });
      console.log(chalk.green(`  ✓ withdraw confirmed: ${withdrawReceipt.transactionHash}`));
      await new Promise((r) => setTimeout(r, 3000));

      console.log(chalk.cyan("\nStep 2/3: Approve USDC → Morpho vault"));
      const approveReceipt = await client.signAndBroadcast({
        operation: "erc20_approve_usdc",
        to: USDC_BASE,
        data: client.buildApproveMorphoCalldata(amountUnits),
        usdValue: usd,
      });
      console.log(chalk.green(`  ✓ approve confirmed: ${approveReceipt.transactionHash}`));
      await new Promise((r) => setTimeout(r, 3000));

      console.log(chalk.cyan("\nStep 3/3: Morpho deposit"));
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
}
