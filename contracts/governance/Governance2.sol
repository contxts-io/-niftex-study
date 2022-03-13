// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "../../openzeppelin-contracts/access/AccessControlEnumerable.sol";
import "../../openzeppelin-contracts/utils/math/Math.sol";
import "../wallet/ShardedWallet.sol";
import "./IGovernance.sol";

contract Governance2 is IGovernance, AccessControlEnumerable
{
    // bytes32 public constant MODULE_ROLE         = bytes32(uint256(keccak256("MODULE_ROLE")) - 1);
    bytes32 public constant MODULE_ROLE         = 0x5098275140f5753db46c42f6e139939968848633a1298402189fdfdafa69b452;
    // bytes32 public constant AUTHORIZATION_RATIO = bytes32(uint256(keccak256("AUTHORIZATION_RATIO")) - 1);
    bytes32 public constant AUTHORIZATION_RATIO = 0x9f280153bc61a10b7af5e9374ead4471b587c3bdcab2b4ab6bdd38136e8544a1;
    address public constant GLOBAL_CONFIG       = address(0);

    mapping(address => mapping(bytes32 => uint256)) internal _config;
    mapping(address => mapping(address => bool   )) internal _disabled;
    mapping(address => mapping(bytes4  => address)) internal _staticcalls;
    mapping(bytes32 => bool) internal _globalOnlyKeys;

    event ModuleDisabled(address wallet, address indexed module, bool disabled);
    event ModuleSet(bytes4 indexed sig, address indexed value, address indexed wallet);
    event GlobalModuleSet(bytes4 indexed sig, address indexed value);
    event ConfigSet(bytes32 indexed key, uint256 indexed value, address indexed wallet);
    event GlobalConfigSet(bytes32 indexed key, uint256 indexed value);
    event GlobalKeySet(bytes32 indexed key, bool indexed value);

    function initialize()
    public
    {
        require(getRoleMemberCount(DEFAULT_ADMIN_ROLE) == 0, "already-initialized");
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /// 모듈이냐 아니냐, 라기보다는 공식적으로 등록된 모듈이냐 그 권한 판단을 해주는 함수다.
    function isModule(address wallet, address module)
    public view override returns (bool)
    {
        return
            /// deploy.js에서 모든 모듈들에 대해서 다음과 같은 코드를 실행해줌.
            /// await governance.grantRole(MODULE_ROLE, module.address);
            /// 그래서 MODULE_ROLE이 role을 가져야만 함.
            /// 보안 상의 이유로 이렇게 체크를 해서 본인들이 배포한 모듈이라는 걸 확신하고 싶었던 걸로 추정함.
            hasRole(MODULE_ROLE, module)
            && !_disabled[wallet][module];
    }

    /// 이 governance를 등록한 wallet이 허용되느냐 안 되느냐를 admin에서 그냥 결정할 수 있다.
    /// 이 governance를 배포한 사람에게 다소 중앙화된 권한이 있다고 볼 수 있다.
    function disableModuleForWallet(address wallet, address module, bool disabled)
    public
    {
        /// _setupRole(DEFAULT_ADMIN_ROLE, msg.sender); 을 했기 때문에 이 걸 체크해준다.
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender));
        _disabled[wallet][module] = disabled;
        emit ModuleDisabled(wallet, module, disabled);
    }

    // ShardedWallet에 세팅된 정족수 넘겨서 의결권을 이 유저가 가지고 있는가 여부를 반환
    function isAuthorized(address wallet, address user)
    public view override returns (bool)
    {
        return ShardedWallet(payable(wallet)).balanceOf(user) >= Math.max(
            ShardedWallet(payable(wallet)).totalSupply() * getConfig(wallet, AUTHORIZATION_RATIO) / 10**18,
            1
        );
    }

    /// wallet과 sig로 governance를 찾아서 쓴다. 간단히 어레이를 만들어서 참조하게 만들어놨다.
    /// wallet에서 이 wallet을
    function getModule(address wallet, bytes4 sig)
    public view override returns (address)
    {
        address global = _staticcalls[GLOBAL_CONFIG][sig];
        address local  = _staticcalls[wallet][sig];
        return _globalOnlyKeys[bytes32(sig)] || local == address(0) ? global : local;
    }

    function setModule(bytes4 sig, address value)
    public
    {
        _staticcalls[msg.sender][sig] = value;
        emit ModuleSet(sig, value, msg.sender);
    }

    function setGlobalModule(bytes4 sig, address value)
    public
    {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender));
        _staticcalls[GLOBAL_CONFIG][sig] = value;
        emit GlobalModuleSet(sig, value);
    }

    //----------------------------------------------------------------

    // wallet별, 혹은 전역의 config setting해주고 조회하는 함수
    function getConfig(address wallet, bytes32 key)
    public view override returns (uint256)
    {
        uint256 global = _config[GLOBAL_CONFIG][key];
        uint256 local  = _config[wallet][key];
        return _globalOnlyKeys[key] || local == 0 ? global : local;
    }

    function setConfig(bytes32 key, uint256 value)
    public
    {
        _config[msg.sender][key] = value;
        emit ConfigSet(key, value, msg.sender);
    }

    function setGlobalConfig(bytes32 key, uint256 value)
    public
    {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender));
        _config[GLOBAL_CONFIG][key] = value;
        emit GlobalConfigSet(key, value);
    }

    //----------------------------------------------------------------

    /// 기타 전역 변수 만들고 조회하는 함수들
    function getGlobalOnlyKey(bytes32 key)
    public view returns (bool)
    {
        return _globalOnlyKeys[key];
    }
    function setGlobalKey(bytes32 key, bool value)
    public
    {
        require(hasRole(DEFAULT_ADMIN_ROLE, msg.sender));
        _globalOnlyKeys[key] = value;
        emit GlobalKeySet(key, value);
    }

    //----------------------------------------------------------------

    /// 이 contract 배포한 address를 그냥 반환해준다. admin address 반환하는 기능 함.
    function getNiftexWallet() public view override returns(address) {
        return getRoleMember(DEFAULT_ADMIN_ROLE, 0);
    }
}
