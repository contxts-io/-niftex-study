const {
  BN,
  constants,
  expectEvent,
  expectRevert,
} = require("@openzeppelin/test-helpers");
const BigNumber = require("bignumber.js");

contract("Workflow", function (accounts) {
  const [
    admin,
    nftOwner,
    cBuyer1,
    cBuyer2,
    mBuyer1,
    mBuyer2,
    artist,
    newAdmin,
    claimant1,
    claimant2,
  ] = accounts;
  const CURVE_PREMINT_RESERVE = "0x3cc5B802b34A42Db4cBe41ae3aD5c06e1A4481c9";

  const ShardedWallet = artifacts.require("ShardedWallet");
  const BondingCurve = artifacts.require("BondingCurve");
  const Governance = artifacts.require("Governance");
  const Modules = {
    Action: { artifact: artifacts.require("ActionModule") },
    Buyout: { artifact: artifacts.require("BuyoutModule") },
    Crowdsale: { artifact: artifacts.require("FixedPriceSaleModule") },
    Factory: { artifact: artifacts.require("ShardedWalletFactory") },
    Multicall: { artifact: artifacts.require("MulticallModule") },
    TokenReceiver: { artifact: artifacts.require("TokenReceiverModule") },
  };
  const Mocks = {
    ERC721: {
      artifact: artifacts.require("ERC721Mock"),
      args: ["ERC721Mock", "721"],
    },
    // ERC777:    { artifact: artifacts.require('ERC777Mock'),  args: [ admin, web3.utils.toWei('1'), 'ERC777Mock', '777', [] ] }, // needs erc1820registry
    ERC1155: { artifact: artifacts.require("ERC1155Mock"), args: [""] },
  };

  let instance;
  let curveInstance;

  before(async function () {
    // Deploy factory
    this.template = await ShardedWallet.new();
    this.bondingcurve = await BondingCurve.new();
    // Deploy governance
    this.governance = await Governance.new();
    // Deploy modules
    this.modules = await Object.entries(Modules).reduce(
      async (acc, [key, { artifact, args }]) => ({
        ...(await acc),
        [key.toLowerCase()]: await artifact.new(
          this.template.address,
          ...(this.extraargs || [])
        ),
      }),
      Promise.resolve({})
    );
    // whitelist modules
    await this.governance.initialize(); // Performed by proxy
    for ({ address } of Object.values(this.modules)) {
      await this.governance.grantRole(
        await this.governance.MODULE_ROLE(),
        address
      );
    }
    // set config
    await this.governance.setGlobalConfig(
      await this.modules.action.ACTION_AUTH_RATIO(),
      web3.utils.toWei("0.01")
    );
    await this.governance.setGlobalConfig(
      await this.modules.buyout.BUYOUT_AUTH_RATIO(),
      web3.utils.toWei("0.01")
    );
    await this.governance.setGlobalConfig(
      await this.modules.action.ACTION_DURATION(),
      50400
    );
    await this.governance.setGlobalConfig(
      await this.modules.buyout.BUYOUT_DURATION(),
      50400
    );
    await this.governance.setGlobalConfig(
      await this.modules.crowdsale.CURVE_TEMPLATE(),
      this.bondingcurve.address
    );
    await this.governance.setGlobalConfig(
      await this.modules.crowdsale.PCT_ETH_TO_CURVE(),
      web3.utils.toWei("0.20")
    ); // 20% eth from crowdsale to bonding curve
    await this.governance.setGlobalConfig(
      await this.bondingcurve.PCT_FEE_NIFTEX(),
      web3.utils.toWei("0.001")
    ); // 0% to niftex initially
    await this.governance.setGlobalConfig(
      await this.bondingcurve.PCT_FEE_ARTIST(),
      web3.utils.toWei("0.001")
    ); // 0.1% to artist initially
    await this.governance.setGlobalConfig(
      await this.bondingcurve.PCT_FEE_SUPPLIERS(),
      web3.utils.toWei("0.003")
    ); // 0.3% to providers initially
    await this.governance.setGlobalConfig(
      await this.bondingcurve.LIQUIDITY_TIMELOCK(),
      100800
    ); // timelock for 1 month

    for (funcSig of Object.keys(this.modules.tokenreceiver.methods).map(
      web3.eth.abi.encodeFunctionSignature
    )) {
      await this.governance.setGlobalModule(
        funcSig,
        this.modules.tokenreceiver.address
      );
    }
    // Deploy Mocks
    this.mocks = await Object.entries(Mocks).reduce(
      async (acc, [key, { artifact, args }]) => ({
        ...(await acc),
        [key.toLowerCase()]: await artifact.new(...(args || [])),
      }),
      Promise.resolve({})
    );
    // Verbose
    const { gasUsed: gasUsedTemplate } = await web3.eth.getTransactionReceipt(
      this.template.transactionHash
    );
    console.log("template deployment:", gasUsedTemplate);
    const { gasUsed: gasUsedFactory } = await web3.eth.getTransactionReceipt(
      this.modules.factory.transactionHash
    );
    console.log("factory deployment:", gasUsedFactory);
  });

  describe("Initialize", function () {
    it("perform", async function () {
      const { receipt } = await this.modules.factory.mintWallet(
        this.governance.address, // governance_
        nftOwner, // owner_
        "Tokenized NFT", // name_
        "TNFT", // symbol_
        constants.ZERO_ADDRESS, // artistWallet_
        { from: nftOwner }
      );
      instance = await ShardedWallet.at(
        receipt.logs.find(({ event }) => event == "NewInstance").args.instance
      );
      console.log("tx.receipt.gasUsed:", receipt.gasUsed);
    });

    after(async function () {
      assert.equal(await instance.owner(), nftOwner);
      assert.equal(await instance.name(), "Tokenized NFT");
      assert.equal(await instance.symbol(), "TNFT");
      assert.equal(await instance.decimals(), "18");
      assert.equal(await instance.totalSupply(), web3.utils.toWei("0"));
      assert.equal(
        await instance.balanceOf(instance.address),
        web3.utils.toWei("0")
      );
      assert.equal(await instance.balanceOf(nftOwner), web3.utils.toWei("0"));
      assert.equal(
        await instance.balanceOf(this.modules.crowdsale.address),
        web3.utils.toWei("0")
      );
      assert.equal(
        await web3.eth.getBalance(this.modules.crowdsale.address),
        web3.utils.toWei("0")
      );
    });
  });

  describe("Prepare tokens", function () {
    it("perform", async function () {
      await this.mocks.erc721.mint(instance.address, 1);
      await this.mocks.erc1155.mint(instance.address, 1, 1, "0x");
    });

    after(async function () {
      assert.equal(await instance.owner(), nftOwner);
      assert.equal(await instance.name(), "Tokenized NFT");
      assert.equal(await instance.symbol(), "TNFT");
      assert.equal(await instance.decimals(), "18");
      assert.equal(await instance.totalSupply(), web3.utils.toWei("0"));
      assert.equal(
        await instance.balanceOf(instance.address),
        web3.utils.toWei("0")
      );
      assert.equal(await instance.balanceOf(nftOwner), web3.utils.toWei("0"));
      assert.equal(
        await instance.balanceOf(this.modules.crowdsale.address),
        web3.utils.toWei("0")
      );
      assert.equal(
        await web3.eth.getBalance(this.modules.crowdsale.address),
        web3.utils.toWei("0")
      );
    });
  });

  describe("Setup crowdsale", function () {
    it("perform", async function () {
      const { receipt } = await this.modules.crowdsale.setup(
        instance.address,
        nftOwner,
        web3.utils.toWei("0.001"), //price
        50400, // duration
        web3.utils.toWei("1000"), // totalSupply
        [
          // 1000개 중에 100개만 파는 것임.
          [nftOwner, web3.utils.toWei("820")],
          [
            // 80개는 AMM pool에 넣는다.
            await this.modules.crowdsale.CURVE_PREMINT_RESERVE(),
            web3.utils.toWei("80"),
          ],
        ],
        { from: nftOwner }
      );
      console.log("tx.receipt.gasUsed:", receipt.gasUsed);
    });

    after(async function () {
      assert.equal(await instance.owner(), this.modules.crowdsale.address);
      assert.equal(await instance.name(), "Tokenized NFT");
      assert.equal(await instance.symbol(), "TNFT");
      assert.equal(await instance.decimals(), "18");
      assert.equal(await instance.totalSupply(), web3.utils.toWei("1000"));
      assert.equal(
        await instance.balanceOf(instance.address),
        web3.utils.toWei("0")
      );
      assert.equal(await instance.balanceOf(nftOwner), web3.utils.toWei("0"));
      assert.equal(
        await instance.balanceOf(this.modules.crowdsale.address),
        web3.utils.toWei("1000")
      );
      assert.equal(
        await web3.eth.getBalance(this.modules.crowdsale.address),
        web3.utils.toWei("0")
      );
      assert.equal(
        await this.modules.crowdsale.premintShards(instance.address, nftOwner),
        web3.utils.toWei("820")
      );
      assert.equal(
        await this.modules.crowdsale.premintShards(
          instance.address,
          CURVE_PREMINT_RESERVE
        ),
        web3.utils.toWei("80")
      );
    });
  });

  describe("cBuyer1 Buy 70 shards in crowdsale", function () {
    it("perform", async function () {
      const { receipt } = await this.modules.crowdsale.buy(
        instance.address,
        cBuyer1,
        {
          from: cBuyer1,
          value: web3.utils.toWei("0.070"), // 70*0.001
        }
      );
      console.log("tx.receipt.gasUsed:", receipt.gasUsed);
    });

    after(async function () {
      assert.equal(await instance.owner(), this.modules.crowdsale.address);
      assert.equal(await instance.name(), "Tokenized NFT");
      assert.equal(await instance.symbol(), "TNFT");
      assert.equal(await instance.decimals(), "18");
      assert.equal(await instance.totalSupply(), web3.utils.toWei("1000"));
      assert.equal(
        await instance.balanceOf(instance.address),
        web3.utils.toWei("0")
      );
      assert.equal(await instance.balanceOf(nftOwner), web3.utils.toWei("0"));
      assert.equal(
        await instance.balanceOf(this.modules.crowdsale.address),
        web3.utils.toWei("1000")
      );
      assert.equal(
        await web3.eth.getBalance(this.modules.crowdsale.address),
        web3.utils.toWei("0.070")
      );
      assert.equal(
        await this.modules.crowdsale.premintShards(instance.address, nftOwner),
        web3.utils.toWei("820")
      );
      assert.equal(
        await this.modules.crowdsale.premintShards(
          instance.address,
          CURVE_PREMINT_RESERVE
        ),
        web3.utils.toWei("80")
      );
      assert.equal(
        await this.modules.crowdsale.boughtShards(instance.address, cBuyer1),
        web3.utils.toWei("70")
      );
      assert.equal(
        await this.modules.crowdsale.boughtShards(instance.address, cBuyer2),
        web3.utils.toWei("0")
      );
    });
  });

  describe("cBuyer2 Buy 30 shards in crowdsale", function () {
    it("perform", async function () {
      const { receipt } = await this.modules.crowdsale.buy(
        instance.address,
        cBuyer2,
        {
          from: cBuyer2,
          value: web3.utils.toWei("0.030"), // 30*0.001
        }
      );
      console.log("tx.receipt.gasUsed:", receipt.gasUsed);
    });

    after(async function () {
      assert.equal(await instance.owner(), constants.ZERO_ADDRESS);
      assert.equal(await instance.name(), "Tokenized NFT");
      assert.equal(await instance.symbol(), "TNFT");
      assert.equal(await instance.decimals(), "18");
      assert.equal(await instance.totalSupply(), web3.utils.toWei("1000"));
      assert.equal(
        await instance.balanceOf(instance.address),
        web3.utils.toWei("0")
      );
      assert.equal(await instance.balanceOf(nftOwner), web3.utils.toWei("0"));
      assert.equal(
        await instance.balanceOf(this.modules.crowdsale.address),
        web3.utils.toWei("1000")
      );
      assert.equal(
        await web3.eth.getBalance(this.modules.crowdsale.address),
        web3.utils.toWei("0.100")
      );
      assert.equal(
        await this.modules.crowdsale.premintShards(instance.address, nftOwner),
        web3.utils.toWei("820")
      );
      assert.equal(
        await this.modules.crowdsale.premintShards(
          instance.address,
          CURVE_PREMINT_RESERVE
        ),
        web3.utils.toWei("80")
      );
      assert.equal(
        await this.modules.crowdsale.boughtShards(instance.address, cBuyer1),
        web3.utils.toWei("70")
      );
      assert.equal(
        await this.modules.crowdsale.boughtShards(instance.address, cBuyer2),
        web3.utils.toWei("30")
      );
    });

    // Not necessary, all shards have been sold.
    it("Move till end of crowdsale", async function () {
      await web3.currentProvider.send(
        { jsonrpc: "2.0", method: "evm_increaseTime", params: [50400], id: 0 },
        () => {}
      );
    });
  });

  describe("cBuyer1 redeem 70 shards in crowdsale", function () {
    it("perform", async function () {
      const { receipt } = await this.modules.crowdsale.redeem(
        instance.address,
        cBuyer1,
        {
          from: cBuyer1,
        }
      );
      console.log("tx.receipt.gasUsed:", receipt.gasUsed);
    });

    after(async function () {
      assert.equal(await instance.owner(), constants.ZERO_ADDRESS);
      assert.equal(await instance.name(), "Tokenized NFT");
      assert.equal(await instance.symbol(), "TNFT");
      assert.equal(await instance.decimals(), "18");
      assert.equal(await instance.totalSupply(), web3.utils.toWei("1000"));
      assert.equal(
        await instance.balanceOf(instance.address),
        web3.utils.toWei("0")
      );
      assert.equal(await instance.balanceOf(nftOwner), web3.utils.toWei("0"));
      assert.equal(await instance.balanceOf(cBuyer1), web3.utils.toWei("70"));
      assert.equal(
        await instance.balanceOf(this.modules.crowdsale.address),
        web3.utils.toWei("930")
      );
      assert.equal(
        await web3.eth.getBalance(this.modules.crowdsale.address),
        web3.utils.toWei("0.100")
      );
      assert.equal(
        await this.modules.crowdsale.premintShards(instance.address, nftOwner),
        web3.utils.toWei("820")
      );
      assert.equal(
        await this.modules.crowdsale.premintShards(
          instance.address,
          CURVE_PREMINT_RESERVE
        ),
        web3.utils.toWei("80")
      );
      assert.equal(
        await this.modules.crowdsale.boughtShards(instance.address, cBuyer1),
        web3.utils.toWei("0")
      );
      assert.equal(
        await this.modules.crowdsale.boughtShards(instance.address, cBuyer2),
        web3.utils.toWei("30")
      );
    });
  });

  describe("cBuyer2 redeem 30 shards in crowdsale", function () {
    it("perform", async function () {
      const { receipt } = await this.modules.crowdsale.redeem(
        instance.address,
        cBuyer2,
        {
          from: cBuyer2,
        }
      );
      console.log("tx.receipt.gasUsed:", receipt.gasUsed);
    });

    after(async function () {
      assert.equal(await instance.owner(), constants.ZERO_ADDRESS);
      assert.equal(await instance.name(), "Tokenized NFT");
      assert.equal(await instance.symbol(), "TNFT");
      assert.equal(await instance.decimals(), "18");
      assert.equal(await instance.totalSupply(), web3.utils.toWei("1000"));
      assert.equal(
        await instance.balanceOf(instance.address),
        web3.utils.toWei("0")
      );
      assert.equal(await instance.balanceOf(nftOwner), web3.utils.toWei("0"));
      assert.equal(await instance.balanceOf(cBuyer1), web3.utils.toWei("70"));
      assert.equal(await instance.balanceOf(cBuyer2), web3.utils.toWei("30"));
      assert.equal(
        await instance.balanceOf(this.modules.crowdsale.address),
        web3.utils.toWei("900")
      );
      assert.equal(
        await web3.eth.getBalance(this.modules.crowdsale.address),
        web3.utils.toWei("0.100")
      );
      assert.equal(
        await this.modules.crowdsale.premintShards(instance.address, nftOwner),
        web3.utils.toWei("820")
      );
      assert.equal(
        await this.modules.crowdsale.premintShards(
          instance.address,
          CURVE_PREMINT_RESERVE
        ),
        web3.utils.toWei("80")
      );
      assert.equal(
        await this.modules.crowdsale.boughtShards(instance.address, cBuyer1),
        web3.utils.toWei("0")
      );
      assert.equal(
        await this.modules.crowdsale.boughtShards(instance.address, cBuyer2),
        web3.utils.toWei("0")
      );
    });
  });

  describe("nftOwner redeem 820 shards in crowdsale", function () {
    it("perform", async function () {
      const { receipt } = await this.modules.crowdsale.redeem(
        instance.address,
        nftOwner,
        {
          from: nftOwner,
        }
      );
      console.log("tx.receipt.gasUsed:", receipt.gasUsed);
    });

    after(async function () {
      assert.equal(await instance.owner(), constants.ZERO_ADDRESS);
      assert.equal(await instance.name(), "Tokenized NFT");
      assert.equal(await instance.symbol(), "TNFT");
      assert.equal(await instance.decimals(), "18");
      assert.equal(await instance.totalSupply(), web3.utils.toWei("1000"));
      assert.equal(
        await instance.balanceOf(instance.address),
        web3.utils.toWei("0")
      );
      assert.equal(await instance.balanceOf(nftOwner), web3.utils.toWei("820"));
      assert.equal(await instance.balanceOf(cBuyer1), web3.utils.toWei("70"));
      assert.equal(await instance.balanceOf(cBuyer2), web3.utils.toWei("30"));
      assert.equal(
        await instance.balanceOf(this.modules.crowdsale.address),
        web3.utils.toWei("80")
      );
      assert.equal(
        await web3.eth.getBalance(this.modules.crowdsale.address),
        web3.utils.toWei("0.100")
      );
      assert.equal(
        await this.modules.crowdsale.premintShards(instance.address, nftOwner),
        web3.utils.toWei("0")
      );
      assert.equal(
        await this.modules.crowdsale.premintShards(
          instance.address,
          CURVE_PREMINT_RESERVE
        ),
        web3.utils.toWei("80")
      );
      assert.equal(
        await this.modules.crowdsale.boughtShards(instance.address, cBuyer1),
        web3.utils.toWei("0")
      );
      assert.equal(
        await this.modules.crowdsale.boughtShards(instance.address, cBuyer2),
        web3.utils.toWei("0")
      );
    });
  });

  describe("withdraw and trigger bonding curve", function () {
    it("perform", async function () {
      const { receipt } = await this.modules.crowdsale.withdraw(
        instance.address,
        { from: nftOwner }
      );
      expectEvent(receipt, "NewBondingCurve", { wallet: instance.address });
      curveInstance = await BondingCurve.at(
        receipt.logs.find(({ event }) => event == "NewBondingCurve").args.curve
      );
      console.log("tx.receipt.gasUsed:", receipt.gasUsed);
      console.log("curveInstance:", curveInstance.address);
    });

    after(async function () {
      assert.equal(await instance.owner(), constants.ZERO_ADDRESS);
      assert.equal(await instance.name(), "Tokenized NFT");
      assert.equal(await instance.symbol(), "TNFT");
      assert.equal(await instance.decimals(), "18");
      assert.equal(await instance.totalSupply(), web3.utils.toWei("1000"));
      assert.equal(
        await instance.balanceOf(instance.address),
        web3.utils.toWei("0")
      );
      assert.equal(await instance.balanceOf(nftOwner), web3.utils.toWei("820"));
      assert.equal(await instance.balanceOf(cBuyer1), web3.utils.toWei("70"));
      assert.equal(await instance.balanceOf(cBuyer2), web3.utils.toWei("30"));
      assert.equal(
        await instance.balanceOf(this.modules.crowdsale.address),
        web3.utils.toWei("0")
      );
      assert.equal(
        await web3.eth.getBalance(this.modules.crowdsale.address),
        web3.utils.toWei("0")
      );
      assert.equal(
        await this.modules.crowdsale.premintShards(instance.address, nftOwner),
        web3.utils.toWei("0")
      );
      assert.equal(
        await this.modules.crowdsale.premintShards(
          instance.address,
          CURVE_PREMINT_RESERVE
        ),
        web3.utils.toWei("0")
      );
      assert.equal(
        await this.modules.crowdsale.boughtShards(instance.address, cBuyer1),
        web3.utils.toWei("0")
      );
      assert.equal(
        await this.modules.crowdsale.boughtShards(instance.address, cBuyer2),
        web3.utils.toWei("0")
      );
    });
  });

  describe("mBuyer1 buy 5 shards", () => {
    it("perform", async () => {
      const shardAmount = new BigNumber(5).times(1e18);
      const maxEthForShardAmount = new BigNumber(10).times(1e18);

      const buyShardsTxn = await curveInstance.buyShards(
        shardAmount,
        maxEthForShardAmount,
        {
          from: mBuyer1,
          value: maxEthForShardAmount,
        }
      );

      const curveCoordinates = await curveInstance.getCurveCoordinates();
      const ethInPool = await curveInstance.getEthInPool();
      const shardsInPool = await instance.balanceOf(curveInstance.address);

      console.log("buyShards gasUsed: ", buyShardsTxn.receipt.gasUsed);
      console.log(
        new BigNumber(curveCoordinates[0]).toFixed(),
        new BigNumber(curveCoordinates[1]).toFixed(),
        "_x, _k"
      );
      console.log(
        new BigNumber(ethInPool).div(1e18).toFixed(),
        new BigNumber(shardsInPool).div(1e18).toFixed(),
        "ethInPool, shardsInPool"
      );
    });

    after(async function () {
      assert.equal(await instance.owner(), constants.ZERO_ADDRESS);
      assert.equal(await instance.name(), "Tokenized NFT");
      assert.equal(await instance.symbol(), "TNFT");
      assert.equal(await instance.decimals(), "18");
      assert.equal(await instance.totalSupply(), web3.utils.toWei("1000"));
      assert.equal(
        await instance.balanceOf(instance.address),
        web3.utils.toWei("0")
      );
      assert.equal(await instance.balanceOf(nftOwner), web3.utils.toWei("820"));
      assert.equal(
        await instance.balanceOf(curveInstance.address),
        web3.utils.toWei("75")
      );
    });
  });

  describe("cBuyer1 buy 5 shards", () => {
    it("perform", async () => {
      const shardAmount = new BigNumber(5).times(1e18);
      const maxEthForShardAmount = new BigNumber(10).times(1e18);

      const buyShardsTxn = await curveInstance.buyShards(
        shardAmount,
        maxEthForShardAmount,
        {
          from: cBuyer1,
          value: maxEthForShardAmount,
        }
      );

      const curveCoordinates = await curveInstance.getCurveCoordinates();
      const ethInPool = await curveInstance.getEthInPool();
      const shardsInPool = await instance.balanceOf(curveInstance.address);

      console.log("buyShards gasUsed: ", buyShardsTxn.receipt.gasUsed);
      console.log(
        new BigNumber(curveCoordinates[0]).toFixed(),
        new BigNumber(curveCoordinates[1]).toFixed(),
        "_x, _k"
      );
      console.log(
        new BigNumber(ethInPool).div(1e18).toFixed(),
        new BigNumber(shardsInPool).div(1e18).toFixed(),
        "ethInPool, shardsInPool"
      );
    });

    after(async function () {
      assert.equal(await instance.owner(), constants.ZERO_ADDRESS);
      assert.equal(await instance.name(), "Tokenized NFT");
      assert.equal(await instance.symbol(), "TNFT");
      assert.equal(await instance.decimals(), "18");
      assert.equal(await instance.totalSupply(), web3.utils.toWei("1000"));
      assert.equal(
        await instance.balanceOf(instance.address),
        web3.utils.toWei("0")
      );
      assert.equal(await instance.balanceOf(nftOwner), web3.utils.toWei("820"));
      assert.equal(
        await instance.balanceOf(curveInstance.address),
        web3.utils.toWei("70")
      );
    });
  });

  describe("cBuyer2 supply 30 shards", () => {
    it("perform", async () => {
      const shardAmount = new BigNumber(30).times(1e18);
      const maxEthForShardAmount = new BigNumber(10).times(1e18);

      await instance.approve(curveInstance.address, constants.MAX_UINT256, {
        from: cBuyer2,
      });

      const buyShardsTxn = await curveInstance.supplyShards(shardAmount, {
        from: cBuyer2,
      });

      const curveCoordinates = await curveInstance.getCurveCoordinates();
      const ethInPool = await curveInstance.getEthInPool();
      const shardsInPool = await instance.balanceOf(curveInstance.address);

      console.log("supplyShards gasUsed: ", buyShardsTxn.receipt.gasUsed);
      console.log(
        new BigNumber(curveCoordinates[0]).toFixed(),
        new BigNumber(curveCoordinates[1]).toFixed(),
        "_x, _k"
      );
      console.log(
        new BigNumber(ethInPool).div(1e18).toFixed(),
        new BigNumber(shardsInPool).div(1e18).toFixed(),
        "ethInPool, shardsInPool"
      );
    });

    after(async function () {
      assert.equal(await instance.owner(), constants.ZERO_ADDRESS);
      assert.equal(await instance.name(), "Tokenized NFT");
      assert.equal(await instance.symbol(), "TNFT");
      assert.equal(await instance.decimals(), "18");
      assert.equal(await instance.totalSupply(), web3.utils.toWei("1000"));
      assert.equal(
        await instance.balanceOf(instance.address),
        web3.utils.toWei("0")
      );
      assert.equal(await instance.balanceOf(nftOwner), web3.utils.toWei("820"));
      assert.equal(
        await instance.balanceOf(curveInstance.address),
        web3.utils.toWei("100")
      );
    });
  });

  describe("cBuyer1 supply 0.001 ETH", () => {
    it("perform", async () => {
      const ethAmount = new BigNumber("0.001").times(1e18);
      const decimals = await curveInstance.decimals();

      console.log(new BigNumber(decimals).toFixed(), "decimals");

      const buyShardsTxn = await curveInstance.supplyEther({
        from: cBuyer1,
        value: ethAmount,
      });

      const curveCoordinates = await curveInstance.getCurveCoordinates();
      const ethInPool = await curveInstance.getEthInPool();
      const shardsInPool = await instance.balanceOf(curveInstance.address);

      console.log("supplyEther gasUsed: ", buyShardsTxn.receipt.gasUsed);
      console.log(
        new BigNumber(curveCoordinates[0]).toFixed(),
        new BigNumber(curveCoordinates[1]).toFixed(),
        "_x, _k"
      );
      console.log(
        new BigNumber(ethInPool).div(1e18).toFixed(),
        new BigNumber(shardsInPool).div(1e18).toFixed(),
        "ethInPool, shardsInPool"
      );
    });

    after(async function () {
      assert.equal(await instance.owner(), constants.ZERO_ADDRESS);
      assert.equal(await instance.name(), "Tokenized NFT");
      assert.equal(await instance.symbol(), "TNFT");
      assert.equal(await instance.decimals(), "18");
      assert.equal(await instance.totalSupply(), web3.utils.toWei("1000"));
      assert.equal(
        await instance.balanceOf(instance.address),
        web3.utils.toWei("0")
      );
      assert.equal(await instance.balanceOf(nftOwner), web3.utils.toWei("820"));
      assert.equal(
        await instance.balanceOf(curveInstance.address),
        web3.utils.toWei("100")
      );
    });
  });

  describe("mBuyer1 sells 5 shards", () => {
    it("perform", async () => {
      const shardAmount = new BigNumber(5).times(1e18);

      await instance.approve(curveInstance.address, constants.MAX_UINT256, {
        from: mBuyer1,
      });

      const buyShardsTxn = await curveInstance.sellShards(
        shardAmount,
        new BigNumber(0).times(1e18),
        {
          from: mBuyer1,
        }
      );

      const curveCoordinates = await curveInstance.getCurveCoordinates();
      const ethInPool = await curveInstance.getEthInPool();
      const shardsInPool = await instance.balanceOf(curveInstance.address);

      console.log("sellShards gasUsed: ", buyShardsTxn.receipt.gasUsed);
      console.log(
        new BigNumber(curveCoordinates[0]).toFixed(),
        new BigNumber(curveCoordinates[1]).toFixed(),
        "_x, _k"
      );
      console.log(
        new BigNumber(ethInPool).div(1e18).toFixed(),
        new BigNumber(shardsInPool).div(1e18).toFixed(),
        "ethInPool, shardsInPool"
      );
    });

    after(async function () {
      assert.equal(await instance.owner(), constants.ZERO_ADDRESS);
      assert.equal(await instance.name(), "Tokenized NFT");
      assert.equal(await instance.symbol(), "TNFT");
      assert.equal(await instance.decimals(), "18");
      assert.equal(await instance.totalSupply(), web3.utils.toWei("1000"));
      assert.equal(
        await instance.balanceOf(instance.address),
        web3.utils.toWei("0")
      );
      assert.equal(await instance.balanceOf(nftOwner), web3.utils.toWei("820"));
      assert.equal(
        await instance.balanceOf(curveInstance.address),
        web3.utils.toWei("105")
      );
    });

    it("Move till end of timelock", async function () {
      await web3.currentProvider.send(
        { jsonrpc: "2.0", method: "evm_increaseTime", params: [100800], id: 0 },
        () => {}
      );
    });
  });

  describe("nftOwner transfer timelock", () => {
    it("perform", async () => {
      const shardAmount = new BigNumber(5).times(1e18);

      const buyShardsTxn = await curveInstance.transferTimelockLiquidity();

      const curveCoordinates = await curveInstance.getCurveCoordinates();
      const ethInPool = await curveInstance.getEthInPool();
      const shardsInPool = await instance.balanceOf(curveInstance.address);

      console.log(
        "transferTimelockLiquidity gasUsed: ",
        buyShardsTxn.receipt.gasUsed
      );
      console.log(
        new BigNumber(curveCoordinates[0]).toFixed(),
        new BigNumber(curveCoordinates[1]).toFixed(),
        "_x, _k"
      );
      console.log(
        new BigNumber(ethInPool).div(1e18).toFixed(),
        new BigNumber(shardsInPool).div(1e18).toFixed(),
        "ethInPool, shardsInPool"
      );
    });

    after(async function () {
      assert.equal(await instance.owner(), constants.ZERO_ADDRESS);
      assert.equal(await instance.name(), "Tokenized NFT");
      assert.equal(await instance.symbol(), "TNFT");
      assert.equal(await instance.decimals(), "18");
      assert.equal(await instance.totalSupply(), web3.utils.toWei("1000"));
      assert.equal(
        await instance.balanceOf(instance.address),
        web3.utils.toWei("0")
      );
      assert.equal(await instance.balanceOf(nftOwner), web3.utils.toWei("820"));
      assert.equal(
        await instance.balanceOf(curveInstance.address),
        web3.utils.toWei("105")
      );
    });
  });

  const LPAccounts = [nftOwner, cBuyer1, cBuyer2];

  describe("3 LPs withdraw liquidity", () => {
    for (let i = 0; i < 3; i++) {
      it(`${LPAccounts[i]} withdraw ETH liquidity`, async () => {
        const ethLPTokensAmount = await curveInstance.getEthLPTokens(
          LPAccounts[i]
        );
        console.log(
          `${LPAccounts[i]}'s ethLPTokensAmount: ${ethLPTokensAmount.toString(
            10
          )}`
        );

        if (ethLPTokensAmount > 0) {
          const withdrawEth = await curveInstance.withdrawSuppliedEther(
            ethLPTokensAmount,
            { from: LPAccounts[i] }
          );
          const withdrawEthLiquidity = withdrawEth.logs[0].args;
          console.log("withdrawEth.gasUsed:", withdrawEth.receipt.gasUsed);
          console.log(
            `${LPAccounts[i]} withdraw ${new BigNumber(withdrawEthLiquidity[0])
              .div(1e18)
              .toFixed()} ETH and ${new BigNumber(withdrawEthLiquidity[1])
              .div(1e18)
              .toFixed()} Shards`
          );
        } else {
          await expectRevert.unspecified(
            curveInstance.withdrawSuppliedEther(ethLPTokensAmount, {
              from: LPAccounts[i],
            })
          );
        }
      });
    }

    for (let i = 0; i < 3; i++) {
      it(`${LPAccounts[i]} withdraw Shard liquidity`, async () => {
        const shardLPTokensAmount = await curveInstance.getShardLPTokens(
          LPAccounts[i]
        );
        console.log(
          `${
            LPAccounts[i]
          }'s shardLPTokensAmount: ${shardLPTokensAmount.toString(10)}`
        );

        if (shardLPTokensAmount > 0) {
          const withdrawShard = await curveInstance.withdrawSuppliedShards(
            shardLPTokensAmount,
            { from: LPAccounts[i] }
          );
          const withdrawShardLiquidity = withdrawShard.logs[0].args;
          console.log("withdrawShard.gasUsed:", withdrawShard.receipt.gasUsed);
          console.log(
            `${LPAccounts[i]} withdraw ${new BigNumber(
              withdrawShardLiquidity[0]
            )
              .div(1e18)
              .toFixed()} ETH and ${new BigNumber(withdrawShardLiquidity[1])
              .div(1e18)
              .toFixed()} Shards`
          );
        } else {
          await expectRevert.unspecified(
            curveInstance.withdrawSuppliedShards(shardLPTokensAmount, {
              from: LPAccounts[i],
            })
          );
        }
      });
    }

    it("check if ethInPool and shardsInPool are both the remaining for artist and NIFTEX", async () => {
      const curveCoordinates = await curveInstance.getCurveCoordinates();
      const ethInPool = await curveInstance.getEthInPool();
      const shardsInPool = await instance.balanceOf(curveInstance.address);

      console.log(
        new BigNumber(curveCoordinates[0]).toFixed(),
        new BigNumber(curveCoordinates[1]).toFixed(),
        "_x, _k"
      );
      console.log(
        new BigNumber(ethInPool).div(1e18).toFixed(),
        new BigNumber(shardsInPool).div(1e18).toFixed(),
        "ethInPool, shardsInPool"
      );

      const ethSuppliers = await curveInstance.getEthSuppliers();
      console.log(
        "ethSuppliers (suppliedEthPlusFees, ethLPTokens, ethFeesToNiftex, ethFeesToArtist): ",
        new BigNumber(ethSuppliers[0]).div(1e18).toFixed(),
        new BigNumber(ethSuppliers[1]).div(1e18).toFixed(),
        new BigNumber(ethSuppliers[2]).div(1e18).toFixed(),
        new BigNumber(ethSuppliers[3]).div(1e18).toFixed()
      );

      const shardSuppliers = await curveInstance.getShardSuppliers();
      console.log(
        "shardSuppliers (suppliedShardPlusFees, shardLPTokens, shardFeesToNiftex, shardFeesToArtist): ",
        new BigNumber(shardSuppliers[0]).div(1e18).toFixed(),
        new BigNumber(shardSuppliers[1]).div(1e18).toFixed(),
        new BigNumber(shardSuppliers[2]).div(1e18).toFixed(),
        new BigNumber(shardSuppliers[3]).div(1e18).toFixed()
      );
    });
  });
});
