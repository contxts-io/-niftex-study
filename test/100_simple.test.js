const {
  BN,
  constants,
  expectEvent,
  expectRevert,
} = require("@openzeppelin/test-helpers");

contract("Workflow", function (accounts) {
  const [admin, user1, user2, user3, other1, other2, other3] = accounts;

  const ShardedWallet = artifacts.require("ShardedWallet");
  const Governance = artifacts.require("Governance");
  const Modules = {
    Action: { artifact: artifacts.require("ActionModule") },
    Buyout: { artifact: artifacts.require("BuyoutModule") },
    Crowdsale: { artifact: artifacts.require("BasicDistributionModule") },
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

  before(async function () {
    // Deploy template
    this.template = await ShardedWallet.new();
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

  it("Modules metadata", async function () {
    for ([name, module] of Object.entries(this.modules)) {
      console.log(">>", name, await module.name());
    }
  });

  describe("Initialize", function () {
    it("perform", async function () {
      const { receipt } = await this.modules.factory.mintWallet(
        this.governance.address, // governance_
        user1, // owner_
        "Tokenized NFT", // name_
        "TNFT", // symbol_
        constants.ZERO_ADDRESS // artistWallet_
      );
      instance = await ShardedWallet.at(
        receipt.logs.find(({ event }) => event == "NewInstance").args.instance
      );
      console.log("tx.receipt.gasUsed:", receipt.gasUsed);
    });

    after(async function () {
      assert.equal(await instance.owner(), user1);
      assert.equal(await instance.name(), "Tokenized NFT");
      assert.equal(await instance.symbol(), "TNFT");
      assert.equal(await instance.decimals(), "18");
      assert.equal(await instance.totalSupply(), "0");
      assert.equal(await instance.balanceOf(instance.address), "0");
      assert.equal(await instance.balanceOf(user1), "0");
      assert.equal(await instance.balanceOf(user2), "0");
      assert.equal(await instance.balanceOf(user3), "0");
      assert.equal(await instance.balanceOf(other1), "0");
      assert.equal(await instance.balanceOf(other2), "0");
      assert.equal(await instance.balanceOf(other3), "0");
      assert.equal(
        await web3.eth.getBalance(instance.address),
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
      assert.equal(await instance.owner(), user1);
      assert.equal(await instance.name(), "Tokenized NFT");
      assert.equal(await instance.symbol(), "TNFT");
      assert.equal(await instance.decimals(), "18");
      assert.equal(await instance.totalSupply(), "0");
      assert.equal(await instance.balanceOf(instance.address), "0");
      assert.equal(await instance.balanceOf(user1), "0");
      assert.equal(await instance.balanceOf(user2), "0");
      assert.equal(await instance.balanceOf(user3), "0");
      assert.equal(await instance.balanceOf(other1), "0");
      assert.equal(await instance.balanceOf(other2), "0");
      assert.equal(await instance.balanceOf(other3), "0");
      assert.equal(await this.mocks.erc721.ownerOf(1), instance.address);
      assert.equal(
        await web3.eth.getBalance(instance.address),
        web3.utils.toWei("0")
      );
    });
  });

  describe("Setup crowdsale", function () {
    it("perform", async function () {
      const { receipt } = await this.modules.crowdsale.setup(
        instance.address,
        [
          [user1, 8],
          [user2, 2],
        ],
        { from: user1 }
      );
      console.log("tx.receipt.gasUsed:", receipt.gasUsed);
    });

    after(async function () {
      assert.equal(await instance.owner(), constants.ZERO_ADDRESS);
      assert.equal(await instance.name(), "Tokenized NFT");
      assert.equal(await instance.symbol(), "TNFT");
      assert.equal(await instance.decimals(), "18");
      assert.equal(await instance.totalSupply(), "10");
      assert.equal(await instance.balanceOf(instance.address), "0");
      assert.equal(await instance.balanceOf(user1), "8");
      assert.equal(await instance.balanceOf(user2), "2");
      assert.equal(await instance.balanceOf(user3), "0");
      assert.equal(await instance.balanceOf(other1), "0");
      assert.equal(await instance.balanceOf(other2), "0");
      assert.equal(await instance.balanceOf(other3), "0");
      assert.equal(await this.mocks.erc721.ownerOf(1), instance.address);
      assert.equal(
        await web3.eth.getBalance(instance.address),
        web3.utils.toWei("0")
      );
    });
  });

  describe("Transfers", function () {
    it("perform", async function () {
      for (from of [user1, user2]) {
        await instance.transfer(other1, await instance.balanceOf(from), {
          from,
        });
      }
    });

    after(async function () {
      assert.equal(await instance.owner(), constants.ZERO_ADDRESS);
      assert.equal(await instance.name(), "Tokenized NFT");
      assert.equal(await instance.symbol(), "TNFT");
      assert.equal(await instance.decimals(), "18");
      assert.equal(await instance.totalSupply(), "10");
      assert.equal(await instance.balanceOf(instance.address), "0");
      assert.equal(await instance.balanceOf(user1), "0");
      assert.equal(await instance.balanceOf(user2), "0");
      assert.equal(await instance.balanceOf(user3), "0");
      assert.equal(await instance.balanceOf(other1), "10");
      assert.equal(await instance.balanceOf(other2), "0");
      assert.equal(await instance.balanceOf(other3), "0");
      assert.equal(await this.mocks.erc721.ownerOf(1), instance.address);
      assert.equal(
        await web3.eth.getBalance(instance.address),
        web3.utils.toWei("0")
      );
    });
  });

  describe("Retrieve ownership", function () {
    it("perform", async function () {
      await instance.retrieve(other1, { from: other1 });
    });

    after(async function () {
      assert.equal(await instance.owner(), other1);
      assert.equal(await instance.name(), "Tokenized NFT");
      assert.equal(await instance.symbol(), "TNFT");
      assert.equal(await instance.decimals(), "18");
      assert.equal(await instance.totalSupply(), "0");
      assert.equal(await instance.balanceOf(instance.address), "0");
      assert.equal(await instance.balanceOf(user1), "0");
      assert.equal(await instance.balanceOf(user2), "0");
      assert.equal(await instance.balanceOf(user3), "0");
      assert.equal(await instance.balanceOf(other1), "0");
      assert.equal(await instance.balanceOf(other2), "0");
      assert.equal(await instance.balanceOf(other3), "0");
      assert.equal(await this.mocks.erc721.ownerOf(1), instance.address);
      assert.equal(
        await web3.eth.getBalance(instance.address),
        web3.utils.toWei("0")
      );
    });
  });

  describe("Execute (get NFT)", function () {
    it("perform", async function () {
      /// 여기서 이렇게 execute 해주고 있다. 흠... 너무 중앙화돼있는 것 같다.
      await instance.execute(
        this.mocks.erc721.address,
        "0",
        this.mocks.erc721.contract.methods
          .safeTransferFrom(instance.address, other1, 1)
          .encodeABI(),
        { from: other1 }
      );
    });

    after(async function () {
      assert.equal(await instance.owner(), other1);
      assert.equal(await instance.name(), "Tokenized NFT");
      assert.equal(await instance.symbol(), "TNFT");
      assert.equal(await instance.decimals(), "18");
      assert.equal(await instance.totalSupply(), "0");
      assert.equal(await instance.balanceOf(instance.address), "0");
      assert.equal(await instance.balanceOf(user1), "0");
      assert.equal(await instance.balanceOf(user2), "0");
      assert.equal(await instance.balanceOf(user3), "0");
      assert.equal(await instance.balanceOf(other1), "0");
      assert.equal(await instance.balanceOf(other2), "0");
      assert.equal(await instance.balanceOf(other3), "0");
      assert.equal(await this.mocks.erc721.ownerOf(1), other1);
      assert.equal(
        await web3.eth.getBalance(instance.address),
        web3.utils.toWei("0")
      );
    });
  });
});
