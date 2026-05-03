// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * FlashArbBot — zero-capital arbitrage on Base via Aave V3 flash loans.
 *
 * Flow:
 *   1. Bot detects price discrepancy between two DEXs (off-chain monitoring)
 *   2. Call executeArb() with the trade params
 *   3. Aave lends us the amount in a single tx
 *   4. We buy low on DEX A, sell high on DEX B
 *   5. Repay Aave + 0.05% premium, keep the spread
 *
 * Owner-only: only the treasury wallet can call executeArb().
 * If a trade isn't profitable after premium, the tx reverts (no loss).
 */

interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

interface IAavePool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external view returns (uint256[] memory amounts);
}

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract FlashArbBot is IFlashLoanSimpleReceiver {
    address public immutable owner;
    address public immutable aavePool;

    // Base mainnet addresses
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    struct ArbParams {
        address dexA;       // buy side router (Uniswap-compatible)
        address dexB;       // sell side router (Uniswap-compatible)
        address[] pathAtoB; // token path for the buy leg (e.g. USDC → WETH)
        address[] pathBtoA; // token path for the sell leg (e.g. WETH → USDC)
        uint256 minProfit;  // minimum profit in USDC units after premium (reverts if not met)
    }

    constructor(address _aavePool) {
        owner = msg.sender;
        aavePool = _aavePool;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    /**
     * Initiate a flash loan arb. Called by the owner off-chain when an
     * opportunity is detected.
     *
     * @param asset     Token to borrow (usually USDC)
     * @param amount    Amount to borrow (in token units)
     * @param params    ABI-encoded ArbParams
     */
    function executeArb(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external onlyOwner {
        IAavePool(aavePool).flashLoanSimple(
            address(this),
            asset,
            amount,
            params,
            0
        );
    }

    /**
     * Aave calls this after lending us the funds.
     * We execute the arb here, then approve repayment.
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == aavePool, "caller not Aave pool");
        require(initiator == address(this), "invalid initiator");

        ArbParams memory arb = abi.decode(params, (ArbParams));

        uint256 startBalance = IERC20(asset).balanceOf(address(this));

        // Buy on DEX A (e.g. USDC → WETH at lower price)
        IERC20(arb.pathAtoB[0]).approve(arb.dexA, amount);
        IUniswapV2Router(arb.dexA).swapExactTokensForTokens(
            amount,
            0, // accept any amount (protected by minProfit check below)
            arb.pathAtoB,
            address(this),
            block.timestamp + 60
        );

        // Sell on DEX B (e.g. WETH → USDC at higher price)
        address midToken = arb.pathAtoB[arb.pathAtoB.length - 1];
        uint256 midBalance = IERC20(midToken).balanceOf(address(this));
        IERC20(midToken).approve(arb.dexB, midBalance);
        IUniswapV2Router(arb.dexB).swapExactTokensForTokens(
            midBalance,
            0,
            arb.pathBtoA,
            address(this),
            block.timestamp + 60
        );

        uint256 endBalance = IERC20(asset).balanceOf(address(this));
        uint256 repayAmount = amount + premium;

        // Revert if not profitable enough (protects against bad trades)
        require(
            endBalance >= startBalance + arb.minProfit,
            "arb not profitable"
        );
        require(endBalance >= repayAmount, "cannot repay flash loan");

        // Approve Aave repayment
        IERC20(asset).approve(aavePool, repayAmount);

        return true;
    }

    /**
     * Withdraw any accumulated profit to the owner wallet.
     */
    function withdraw(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        require(bal > 0, "nothing to withdraw");
        IERC20(token).transfer(owner, bal);
    }

    /**
     * Quote helper: check if an arb is profitable before executing.
     * Returns expected profit in `asset` units after Aave premium.
     * Returns 0 if not profitable.
     */
    function quoteArb(
        address dexA,
        address dexB,
        address[] calldata pathAtoB,
        address[] calldata pathBtoA,
        uint256 amount
    ) external view returns (uint256 profit) {
        // Aave flash loan premium is 0.05% = 5 bps
        uint256 premium = (amount * 5) / 10000;

        // Simulate buy on DEX A
        uint256[] memory amountsAfterBuy = IUniswapV2Router(dexA).getAmountsOut(amount, pathAtoB);
        uint256 midAmount = amountsAfterBuy[amountsAfterBuy.length - 1];

        // Simulate sell on DEX B
        uint256[] memory amountsAfterSell = IUniswapV2Router(dexB).getAmountsOut(midAmount, pathBtoA);
        uint256 finalAmount = amountsAfterSell[amountsAfterSell.length - 1];

        if (finalAmount > amount + premium) {
            profit = finalAmount - amount - premium;
        }
    }
}
