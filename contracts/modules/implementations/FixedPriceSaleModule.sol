// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;
pragma abicoder v2;

import "../../../../openzeppelin-contracts/contracts/proxy/Clones.sol";
import "../../initializable/BondingCurve3.sol";
import "../../governance/IGovernance.sol";
import "../../utils/Timers.sol";
import "../ModuleBase.sol";

struct Allocation {
    address receiver;
    uint256 amount;
}

contract FixedPriceSaleModule is IModule, ModuleBase, Timers {
    string public constant override name = type(FixedPriceSaleModule).name;

    // address public constant CURVE_PREMINT_RESERVE   = address(uint160(uint256(keccak256("CURVE_PREMINT_RESERVE")) - 1));
    address public constant CURVE_PREMINT_RESERVE =
        0x3cc5B802b34A42Db4cBe41ae3aD5c06e1A4481c9;
    // bytes32 public constant PCT_ETH_TO_CURVE        = bytes32(uint256(keccak256("PCT_ETH_TO_CURVE")) - 1);
    bytes32 public constant PCT_ETH_TO_CURVE =
        0xd6b8be26fe56c2461902fe9d3f529cdf9f02521932f09d2107fe448477d59e9f;
    // bytes32 public constant CURVE_TEMPLATE          = bytes32(uint256(keccak256("CURVE_TEMPLATE")) - 1);
    bytes32 public constant CURVE_TEMPLATE =
        0x3cec7c13345ae32e688f81840d184c63978bb776762e026e7e61d891bb2dd84b;

    mapping(ShardedWallet => address) public recipients; // NFT 원래 주인
    mapping(ShardedWallet => uint256) public prices; // 가격
    mapping(ShardedWallet => uint256) public balance; // 발행량
    mapping(ShardedWallet => uint256) public remainingShards; // 남아있는 발행량. 크라우드세일에서 아직 안 팔린 량
    mapping(ShardedWallet => mapping(address => uint256)) public premintShards; // 프리민팅
    mapping(ShardedWallet => mapping(address => uint256)) public boughtShards; // 얼마나 팔렸는가.

    event ShardsPrebuy(
        ShardedWallet indexed wallet,
        address indexed receiver,
        uint256 count
    );
    event ShardsBought(
        ShardedWallet indexed wallet,
        address indexed from,
        address to,
        uint256 count
    );
    event ShardsRedeemedSuccess(
        ShardedWallet indexed wallet,
        address indexed from,
        address to,
        uint256 count
    );
    event ShardsRedeemedFailure(
        ShardedWallet indexed wallet,
        address indexed from,
        address to,
        uint256 count
    );
    event OwnershipReclaimed(
        ShardedWallet indexed wallet,
        address indexed from,
        address to
    );
    event Withdraw(
        ShardedWallet indexed wallet,
        address indexed from,
        address to,
        uint256 value
    );
    event NewBondingCurve(ShardedWallet indexed wallet, address indexed curve);

    modifier onlyCrowdsaleActive(ShardedWallet wallet) {
        require(
            _duringTimer(bytes32(uint256(uint160(address(wallet))))) &&
                remainingShards[wallet] > 0
        );
        _;
    }

    modifier onlyCrowdsaleFinished(ShardedWallet wallet) {
        require(
            _afterTimer(bytes32(uint256(uint160(address(wallet))))) ||
                remainingShards[wallet] == 0
        );
        _;
    }

    modifier onlyCrowdsaleSuccess(ShardedWallet wallet) {
        require(remainingShards[wallet] == 0);
        _;
    }

    modifier onlyRecipient(ShardedWallet wallet) {
        require(recipients[wallet] == msg.sender);
        _;
    }

    constructor(address walletTemplate) ModuleBase(walletTemplate) {}

    function setup(
        ShardedWallet wallet,
        address recipient,
        uint256 price,
        uint256 duration, // !TODO controlled by Governance.sol possibly?
        uint256 totalSupply,
        Allocation[] calldata premints
    )
        external
        onlyShardedWallet(wallet)
        onlyBeforeTimer(bytes32(uint256(uint160(address(wallet)))))
        onlyOwner(wallet, msg.sender)
    {
        require(wallet.totalSupply() == 0);
        wallet.moduleMint(address(this), totalSupply);
        wallet.moduleTransferOwnership(address(this));

        Timers._startTimer(
            bytes32(uint256(uint160(address(wallet)))),
            duration
        );

        // Allocate the premints
        for (uint256 i = 0; i < premints.length; ++i) {
            premintShards[wallet][premints[i].receiver] += premints[i].amount;
            totalSupply -= premints[i].amount;
            emit ShardsPrebuy(wallet, premints[i].receiver, premints[i].amount);
        }

        recipients[wallet] = recipient;
        prices[wallet] = price;
        remainingShards[wallet] = totalSupply;
    }

    function buy(ShardedWallet wallet, address to)
        external
        payable
        onlyCrowdsaleActive(wallet)
    {
        require(to != CURVE_PREMINT_RESERVE);

        uint256 price = prices[wallet];
        uint256 count = Math.min(
            (msg.value * 10**18) / price,
            remainingShards[wallet]
        );
        uint256 value = (count * price) / 10**18;

        // balance는 crowdsale되고 나서 정상적인 계좌 잔고 관리할 때 쓰는 mapping이다.
        // 이 balance가 발행총량하고 같아져야 한다.
        // boughtshard도 같이 기록해져서 누구한테 팔렸는지 기록해준다.
        balance[wallet] += value;
        boughtShards[wallet][to] += count;
        remainingShards[wallet] -= count;

        if (remainingShards[wallet] == 0) {
            // crowdsaleSuccess
            wallet.renounceOwnership(); // make address(0) owner for actions
        }

        // 잔돈 반환
        Address.sendValue(payable(msg.sender), msg.value - value);
        emit ShardsBought(wallet, msg.sender, to, count);
    }

    function redeem(ShardedWallet wallet, address to)
        external
        onlyCrowdsaleFinished(wallet)
    {
        require(to != CURVE_PREMINT_RESERVE);

        uint256 premint = premintShards[wallet][to];
        uint256 bought = boughtShards[wallet][to];
        delete premintShards[wallet][to];
        delete boughtShards[wallet][to];

        if (remainingShards[wallet] == 0) {
            // crowdsaleSuccess
            // 와디즈 펀딩 성공! 유저가 shard 찾아감.
            uint256 shards = premint + bought;
            //ERC20
            wallet.transfer(to, shards);
            emit ShardsRedeemedSuccess(wallet, msg.sender, to, shards);
        } else {
            // 와디즈 펀딩 실패. 돈 다시 되돌려줌.
            uint256 value = (bought * prices[wallet]) / 10**18;
            balance[wallet] -= value;
            remainingShards[wallet] += premint + bought;
            // 환불해줌
            Address.sendValue(payable(to), value);
            emit ShardsRedeemedFailure(wallet, msg.sender, to, bought);
        }
    }

    // AMM 배포
    function _makeCurve(
        ShardedWallet wallet,
        uint256 valueToCurve,
        uint256 shardsToCurve
    ) internal returns (address) {
        IGovernance governance = wallet.governance();
        address template = address(
            uint160(governance.getConfig(address(wallet), CURVE_TEMPLATE))
        );

        if (template != address(0)) {
            address curve = Clones.cloneDeterministic(
                template,
                bytes32(uint256(uint160(address(wallet))))
            );
            // erc20의 approve임
            // 샤딩된 NFT 샤드토큰 커브에 넘겨줌
            wallet.approve(curve, shardsToCurve);
            // 샤드와 거래될 ETH를 넘겨줌
            BondingCurve3(curve).initialize{value: valueToCurve}(
                shardsToCurve, // 100개
                address(wallet),
                recipients[wallet],
                prices[wallet]
            );
            emit NewBondingCurve(wallet, curve);
            return curve;
        } else {
            return address(0);
        }
    }

    function withdraw(ShardedWallet wallet)
        public
        onlyCrowdsaleFinished(wallet)
    {
        address to = recipients[wallet];
        if (remainingShards[wallet] == 0) {
            // crowdsaleSuccess
            // 미리 세팅해둔 AMM pool에 넣을 shards의 갯수
            uint256 shardsToCurve = premintShards[wallet][
                CURVE_PREMINT_RESERVE
            ];
            // crowdSale 해서 받은 ETH 중에서 AMM에 얼마나 넣어놓을 것인가를 그 비율(PCT_ETH_TO_CURVE)대로 결정
            uint256 valueToCurve = (balance[wallet] *
                wallet.governance().getConfig(
                    address(wallet),
                    PCT_ETH_TO_CURVE
                )) / 10**18;
            // 남은 ETH
            uint256 value = balance[wallet] - valueToCurve;
            delete balance[wallet];
            delete premintShards[wallet][CURVE_PREMINT_RESERVE];

            address curve = _makeCurve(wallet, valueToCurve, shardsToCurve);

            if (curve == address(0)) {
                wallet.transfer(payable(to), shardsToCurve);
                value += valueToCurve;
            }

            // 남은 ETH 송금
            Address.sendValue(payable(to), value);

            //왜 shard는 전송 안 하냐? 팔았으니까! redeem으로 산 사람들이 찾아감.
            emit Withdraw(wallet, msg.sender, to, value);
        } else {
            // 크라우드세일 실패했으므로 주인이 다시 되찾아감
            wallet.transferOwnership(to);
            emit OwnershipReclaimed(wallet, msg.sender, to);
        }
    }

    // 다 청산해버림
    function cleanup(ShardedWallet wallet)
        external
        onlyCrowdsaleFinished(wallet)
    {
        uint256 totalSupply = wallet.totalSupply();
        require(
            remainingShards[wallet] +
                premintShards[wallet][CURVE_PREMINT_RESERVE] ==
                totalSupply,
            "Crowdsale dirty, not all allocation have been claimed"
        ); // failure + redeems
        wallet.moduleBurn(address(this), totalSupply);
        Timers._resetTimer(bytes32(uint256(uint160(address(wallet)))));
    }

    function deadline(ShardedWallet wallet) external view returns (uint256) {
        return _getDeadline(bytes32(uint256(uint160(address(wallet)))));
    }
}
