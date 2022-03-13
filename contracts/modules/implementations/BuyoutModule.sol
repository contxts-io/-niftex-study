// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "../../../../openzeppelin-contracts/contracts/utils/Address.sol";
import "../../../../openzeppelin-contracts/contracts/utils/math/Math.sol";
import "../../utils/Timers.sol";
import "../ModuleBase.sol";

contract BuyoutModule is IModule, ModuleBase, Timers
{
    string public constant override name = type(BuyoutModule).name;

    // bytes32 public constant BUYOUT_DURATION = bytes32(uint256(keccak256("BUYOUT_DURATION")) - 1);
    bytes32 public constant BUYOUT_DURATION = 0x2b0302f2fecc31c4abdae5dbfeb4ffb88f5e75f2102ec01dda9073a9330d6b1c;
    // bytes 32 public constant BUYOUT_AUTH_RATIO = bytes32(uint256(keccak256("BUYOUT_AUTH_RATIO")) - 1);
    bytes32 public constant BUYOUT_AUTH_RATIO = 0xfe28b1c1d768c9fc13cde756c61b63ec3a40333a8bb3cd2e556327781fbea03c;

    mapping(ShardedWallet => address) internal _proposers;
    mapping(ShardedWallet => uint256) internal _prices;
    mapping(ShardedWallet => uint256) public _deposit;

    event BuyoutOpened(ShardedWallet indexed wallet, address proposer, uint256 pricePerShard);
    event BuyoutClosed(ShardedWallet indexed wallet, address closer);
    event BuyoutClaimed(ShardedWallet indexed wallet, address user);
    event BuyoutFinalized(ShardedWallet indexed wallet);

    modifier buyoutAuthorized(ShardedWallet wallet, address user)
    {
        require(wallet.balanceOf(user) >= Math.max(
            wallet.totalSupply() * wallet.governance().getConfig(address(wallet), BUYOUT_AUTH_RATIO) / 10**18,
            1
        ));
        _;
    }

    constructor(address walletTemplate) ModuleBase(walletTemplate) {}

    /// pricePerShard가 이 유저가 부르는 샤드당 바이아웃 가격, buyoutprice는 지불총액
    function openBuyout(ShardedWallet wallet, uint256 pricePerShard)
    external payable
    onlyShardedWallet(wallet)
    buyoutAuthorized(wallet, msg.sender)
    onlyBeforeTimer(bytes32(uint256(uint160(address(wallet)))))
    {
        require(wallet.owner() == address(0));
        uint256 ownedshards = wallet.balanceOf(msg.sender);
        uint256 buyoutprice = (wallet.totalSupply() - ownedshards) * pricePerShard / 10**18;

        Timers._startTimer(bytes32(uint256(uint160(address(wallet)))), wallet.governance().getConfig(address(wallet), BUYOUT_DURATION));
        _proposers[wallet] = msg.sender;
        _prices[wallet]    = pricePerShard;
        _deposit[wallet]   = buyoutprice;

        /// 소유권을 이 바이아웃 컨트랙트로 옮겨놓는다.
        /// 그러니까 법원 경매 신청해서, 법원이 임시로 소유주가 된 것이다.
        wallet.moduleTransferOwnership(address(this));
        wallet.moduleTransfer(msg.sender, address(this), ownedshards);
        Address.sendValue(payable(msg.sender), msg.value - buyoutprice);

        emit BuyoutOpened(wallet, msg.sender, pricePerShard);
    }

    function closeBuyout(ShardedWallet wallet)
    external payable
    onlyDuringTimer(bytes32(uint256(uint160(address(wallet)))))
    {
        uint256 pricePerShard = _prices[wallet];
        /// 처음엔 0이었을테니, 결국 바이아웃을 주창한 사람이 맡긴 토큰들일 것이다.
        // 이 걸 다 사야 바이아웃이 무효가 된다.
        uint256 lockedShards  = wallet.balanceOf(address(this));
        uint256 buyShards     =
            pricePerShard == 0 ?
                lockedShards :
                Math.min(
                    lockedShards,
                    // 이렇게 하면 몇 개 살 수 있는지가 나온다.
                    msg.value * 10**18 / pricePerShard
                );
        uint256 buyprice      = buyShards * pricePerShard / 10**18;
        _deposit[wallet]     += buyprice;

        // do the transfer (update lockedShards in case of reentrancy attempt)
        wallet.transfer(msg.sender, buyShards);

        // do the close of all locked shards have been bought
        // 이 게 같다는 건 Math.min(lockedShards, msg.value * 10**18 / pricePerShard)
        // msg.value, 즉 지불한 금액이 lockedShards를 다 사고도 남는 것이므로, 바이아웃 방어에 성공한 것임.
        if (buyShards == lockedShards)
        {
            // stop buyout timer & reset wallet ownership
            Timers._stopTimer(bytes32(uint256(uint160(address(wallet)))));
            wallet.renounceOwnership();

            // transfer funds to proposer
            address proposer = _proposers[wallet];
            uint256 deposit  = _deposit[wallet];
            delete _proposers[wallet];
            delete _prices[wallet];
            delete _deposit[wallet];

            // 바이아웃을 시도했던 사람 입장에서는 바이아웃이 실패했으니
            // 바이아웃 시도했던 사람에게 돈 다시 돌려줌.
            Address.sendValue(payable(proposer), deposit);

            // emit event
            emit BuyoutClosed(wallet, msg.sender);
        }

        // refund extra value
        Address.sendValue(payable(msg.sender), msg.value - buyprice);
    }

    /// 바이아웃 신청을 당한 sharedeWallet의 한 유저가 바이아웃을 수락해서,
    /// 샤드 소각하고 그에 해당하는 value를 가진 ETH를 받고 끝난 것이다.
    function claimBuyout(ShardedWallet wallet)
    external
    onlyAfterTimer(bytes32(uint256(uint160(address(wallet)))))
    {
        uint256 pricePerShard = _prices[wallet];
        uint256 shards        = wallet.balanceOf(msg.sender);
        uint256 value         = shards * pricePerShard / 10**18;

        wallet.moduleBurn(msg.sender, shards);
        Address.sendValue(payable(msg.sender), value);

        emit BuyoutClaimed(wallet, msg.sender);
    }

    /// 옛날 방식의 claimBuyout인가 봄.
    /// 우리가 보고 있는 건 v2고, v1 시절의 잔여물로 추정됨.
    function claimBuyoutBackup(ShardedWallet wallet)
    external
    onlyAfterTimer(bytes32(uint256(uint160(address(wallet)))))
    {
        uint256 pricePerShard = _prices[wallet];
        uint256 shards        = wallet.balanceOf(msg.sender);
        uint256 value         = shards * pricePerShard / 10**18;

        wallet.burnFrom(msg.sender, shards);
        Address.sendValue(payable(msg.sender), value);

        emit BuyoutClaimed(wallet, msg.sender);
    }

    /// 바이아웃이 성공해서 이제 sharedWallet 같은 것은 없고 유저가 NFT 가지게 됨.
    function finalizeBuyout(ShardedWallet wallet)
    external
    onlyAfterTimer(bytes32(uint256(uint160(address(wallet)))))
    {
        // Warning: do NOT burn the locked shards, this would allow the last holder to retrieve ownership of the wallet
        require(_proposers[wallet] != address(0));
        wallet.transferOwnership(_proposers[wallet]);
        delete _proposers[wallet];
        delete _deposit[wallet];

        emit BuyoutFinalized(wallet);
    }

    /// 과제 해답
    function buyOutWithInitialBuyoutPrice(ShardedWallet wallet)
    external payable
    onlyShardedWallet(wallet)
    buyoutAuthorized(wallet, msg.sender)
    onlyBeforeTimer(bytes32(uint256(uint160(address(wallet)))))
    {
        require(wallet.owner() == address(0));
        uint256 ownedshards = wallet.balanceOf(msg.sender);
        uint256 buyoutprice = (wallet.totalSupply() - ownedshards) * initialBuyoutPricePerShard / 10**18;

        // 유저가 가지고 있는 샤드 혹시 모르니 다 회수
        wallet.moduleTransfer(msg.sender, address(this), ownedshards);

        // 신청한 유저가 해당 wallet의 주인이 됨
        wallet.transferOwnership(_proposers[wallet]);

        // 잔돈 거슬러줌
        Address.sendValue(payable(msg.sender), msg.value - buyoutprice);

        emit BuyoutOpened(wallet, msg.sender, pricePerShard);
    }
}
