// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;
pragma abicoder v2;

import "../ModuleBase.sol";

struct Allocation
{
    address receiver;
    uint256 amount;
}

contract BasicDistributionModule is IModule, ModuleBase
{
    string public constant override name = type(BasicDistributionModule).name;

    // bytes32 public constant PCT_SHARDS_NIFTEX = bytes32(uint256(keccak256("PCT_SHARDS_NIFTEX")) - 1);
    bytes32 public constant PCT_SHARDS_NIFTEX = 0xfbbd159a3fa06a90e6706a184ef085e653f08384af107f1a8507ee0e3b341aa6;

    constructor(address walletTemplate) ModuleBase(walletTemplate) {}

    function setup(ShardedWallet wallet, Allocation[] calldata mints)
    external onlyOwner(wallet, msg.sender)
    {
        require(wallet.totalSupply() == 0);
        /// 소유권을 그 누구도 가지지 않은 address인 0번으로 옮김
        /// 이제 owner로서 함수를 실행 못 함. 이 분배 함수 실행되기 전에 해 놔야 함.
        wallet.moduleTransferOwnership(address(0));
        for (uint256 i = 0; i < mints.length; ++i)
        {
            wallet.moduleMint(mints[i].receiver, mints[i].amount);
        }

        IGovernance governance = wallet.governance();
        require(
            wallet.balanceOf(governance.getNiftexWallet())
            >=
            wallet.totalSupply() * governance.getConfig(address(wallet), PCT_SHARDS_NIFTEX) / 10**18
        );
    }
}
