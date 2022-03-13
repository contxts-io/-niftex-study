// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "../../utils/CloneFactory.sol";
import "../ModuleBase.sol";
import "./BuyoutModule.sol";

contract ShardedWalletFactory is
    IModule,
    ModuleBase,
    CloneFactory,
    BuyoutModule
{
    string public constant override name = type(ShardedWalletFactory).name;

    constructor(address walletTemplate)
        ModuleBase(walletTemplate)
        CloneFactory(walletTemplate)
    {}

    function mintWallet(
        address governance_,
        address owner_,
        string calldata name_,
        string calldata symbol_,
        address artistWallet_,
        uint256 pricePerShard
    ) external returns (address instance) {
        instance = _clone();
        ShardedWallet wallet = ShardedWallet(payable(instance)).initialize(
            governance_,
            owner_,
            name_,
            symbol_,
            artistWallet_,
            pricePerShard
        );

        // require 권한 확인 의미 있을까?
        // require(onlyOwner(wallet, owner_));

        // shard 가격 설정. 여기서하는거 아닌듯
        // openBuyout(wallet, pricePerShard);
    }
}
