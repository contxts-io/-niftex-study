// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "../../../openzeppelin-contracts/contracts/utils/Address.sol";
import "../../../openzeppelin-contracts/contracts/utils/math/Math.sol";
import "../governance/IGovernance.sol";
import "../initializable/Ownable.sol";
import "../initializable/ERC20.sol";
import "../initializable/ERC1363.sol";

contract ShardedWallet is Ownable, ERC20, ERC1363Approve
{
    // bytes32 public constant ALLOW_GOVERNANCE_UPGRADE = bytes32(uint256(keccak256("ALLOW_GOVERNANCE_UPGRADE")) - 1);
    bytes32 public constant ALLOW_GOVERNANCE_UPGRADE = 0xedde61aea0459bc05d70dd3441790ccfb6c17980a380201b00eca6f9ef50452a;

    IGovernance public governance;
    address public artistWallet;

    event Received(address indexed sender, uint256 value, bytes data);
    event Execute(address indexed to, uint256 value, bytes data);
    event ModuleExecute(address indexed module, address indexed to, uint256 value, bytes data);
    event GovernanceUpdated(address indexed oldGovernance, address indexed newGovernance);
    event ArtistUpdated(address indexed oldArtist, address indexed newArtist);

    /// 등록된 모듈이어야 실행 가능하다.
    modifier onlyModule()
    {
        require(_isModule(msg.sender), "Access restricted to modules");
        _;
    }

    /*************************************************************************
     *                       Contructor and fallbacks                        *
     *************************************************************************/
    constructor()
    {
        // 배포된 거버넌스 컨트랙트 주소를 하드 코딩해버림.
        governance = IGovernance(address(0xdead));
    }

    receive()
    external payable
    {
        emit Received(msg.sender, msg.value, bytes(""));
    }

    /// data 없이 이 컨트랙트가 토큰 송금을 받으면 fallback 함수가 자동으로 돌아간다고 함.
    /// 무슨 내용의 함수인지는 모르겠는데 그냥 받았다고 이벤트 찍어주는 게 다인 듯.
    fallback()
    external payable
    {
        address module = governance.getModule(address(this), msg.sig);
        if (module != address(0) && _isModule(module))
        {
            (bool success, /*bytes memory returndata*/) = module.staticcall(msg.data);
            // returning bytes in fallback is not supported until solidity 0.8.0
            // solhint-disable-next-line no-inline-assembly
            assembly {
                returndatacopy(0, 0, returndatasize())
                switch success
                case 0 { revert(0, returndatasize()) }
                default { return (0, returndatasize()) }
            }
        }
        else
        {
            emit Received(msg.sender, msg.value, msg.data);
        }
    }

    /*************************************************************************
     *                            Initialization                             *
     *************************************************************************/
    function initialize(
        address         governance_,
        address         minter_,
        string calldata name_,
        string calldata symbol_,
        address         artistWallet_
    )
    external
    {
        /// 아마 초기화할 때 0으로 돼 있는 뭔가가 있나봄. 상속 관계 등이 복잡해서 잘 안 찾아짐..
        require(address(governance) == address(0));

        governance = IGovernance(governance_);
        Ownable._setOwner(minter_);
        ERC20._initialize(name_, symbol_);
        artistWallet = artistWallet_;

        emit GovernanceUpdated(address(0), governance_);
    }

    function _isModule(address module)
    internal view returns (bool)
    {
        return governance.isModule(address(this), module);
    }

    /*************************************************************************
     *                          Owner interactions                           *
     *************************************************************************/
    // 이 컨트랙트가 직접 abi와 data를 넣어서 call하게 만드는 함수.. test js file 참조
    // 컨트랙트 단에서 직접 쓰이는 일은 없는 것 같다.
   function execute(address to, uint256 value, bytes calldata data)
    external onlyOwner()
    {
        Address.functionCallWithValue(to, data, value);
        emit Execute(to, value, data);
    }

    function retrieve(address newOwner)
    external
    {
        ERC20._burn(msg.sender, Math.max(ERC20.totalSupply(), 1));
        Ownable._setOwner(newOwner);
    }

    /*************************************************************************
     *                          Module interactions                          *
     *************************************************************************/
    function moduleExecute(address to, uint256 value, bytes calldata data)
    external onlyModule()
    {
        // 배포된 컨트랙트라면 functionCallWithValue가 작동 가능하다.
        // 계속 참조해서 들어가면 target.call{value: value}(data)이 나온다.
        // avoid too low level code라고 나오는 거 보니 내부 구현구조까지 직접 들어가서 call해버리는 함수인 듯.
        // 지금은 사용이 지양되고 있는 것 같다.
        if (Address.isContract(to))
        {
            Address.functionCallWithValue(to, data, value);
        }
        else
        {
            Address.sendValue(payable(to), value);
        }
        emit ModuleExecute(msg.sender, to, value, data);
    }

    function moduleMint(address to, uint256 value)
    external onlyModule()
    {
        ERC20._mint(to, value);
    }

    function moduleBurn(address from, uint256 value)
    external onlyModule()
    {
        ERC20._burn(from, value);
    }

    function moduleTransfer(address from, address to, uint256 value)
    external onlyModule()
    {
        ERC20._transfer(from, to, value);
    }

    function moduleTransferOwnership(address to)
    external onlyModule()
    {
        Ownable._setOwner(to);
    }

    function updateGovernance(address newGovernance)
    external onlyModule()
    {
        emit GovernanceUpdated(address(governance), newGovernance);

        /// deploy.js에서 [await shardedwallet.ALLOW_GOVERNANCE_UPGRADE()]: true,
        /// 위와 같은 코드가 작동하였기 때문에 아래와 같은 require문이 유의미하다.
        require(governance.getConfig(address(this), ALLOW_GOVERNANCE_UPGRADE) > 0);
        require(Address.isContract(newGovernance));
        governance = IGovernance(newGovernance);
    }

    function updateArtistWallet(address newArtistWallet)
    external onlyModule()
    {
        emit ArtistUpdated(artistWallet, newArtistWallet);

        artistWallet = newArtistWallet;
    }
}
