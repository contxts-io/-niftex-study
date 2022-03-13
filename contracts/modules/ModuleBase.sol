// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "../wallet/ShardedWallet.sol";
import "./IModule.sol";

abstract contract ModuleBase is IModule
{
    address immutable public walletTemplate;

    constructor(address walletTemplate_)
    {
        walletTemplate = walletTemplate_;
    }

    /// 처음에 ShardedWalletFactory에서 복제를 해서 생성했으니, 그렇게 생성되었는지를 체크하는 것이다.
    modifier onlyShardedWallet(ShardedWallet wallet)
    {
        require(isClone(walletTemplate, address(wallet)));
        _;
    }

    modifier onlyAuthorized(ShardedWallet wallet, address user)
    {
        require(wallet.governance().isAuthorized(address(wallet), user));
        _;
    }

    modifier onlyOwner(ShardedWallet wallet, address user)
    {
        require(wallet.owner() == user);
        _;
    }

    function isClone(address target, address query)
    internal view returns (bool result)
    {
        bytes20 targetBytes = bytes20(target);
        /// 어셈블리어로 같은지 확인해주는 코드들
        assembly {
            let clone := mload(0x40)
            mstore(clone, 0x363d3d373d3d3d363d7300000000000000000000000000000000000000000000)
            mstore(add(clone, 0xa), targetBytes)
            mstore(add(clone, 0x1e), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)

            let other := add(clone, 0x40)
            extcodecopy(query, other, 0, 0x2d)
            result := and(
                eq(mload(clone), mload(other)),
                eq(mload(add(clone, 0xd)), mload(add(other, 0xd)))
            )
        }
    }
}
