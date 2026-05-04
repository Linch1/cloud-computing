const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Deploys the VotingRegistry contract.
 *
 * The deployer (signer #0) is set as the initial owner. To override, set the
 * INITIAL_OWNER env var to a different address.
 *
 * After a successful deployment the script writes a small JSON manifest to
 * `deployments/<network>.json` so that the backend / frontend can pick up
 * the contract address without scraping logs.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.js --network localhost
 *   npx hardhat run scripts/deploy.js --network hardhat
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const initialOwner = process.env.INITIAL_OWNER || (await deployer.getAddress());

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Network:        ", network.name);
  console.log("Deployer:       ", deployer.address);
  console.log("Deployer balance:", ethers.formatEther(balance), "ETH");
  console.log("Initial owner:  ", initialOwner);

  const Factory = await ethers.getContractFactory("VotingRegistry");
  const contract = await Factory.deploy(initialOwner);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const tx = contract.deploymentTransaction();

  console.log("\nVotingRegistry deployed:");
  console.log("  address: ", address);
  console.log("  tx hash: ", tx ? tx.hash : null);
  console.log("  block:   ", tx && tx.blockNumber ? tx.blockNumber : "(pending)");

  const manifest = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    contract: "VotingRegistry",
    address,
    initialOwner,
    deployer: deployer.address,
    txHash: tx ? tx.hash : null,
    deployedAt: new Date().toISOString(),
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2));
  console.log(`\nManifest written to ${path.relative(process.cwd(), outFile)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
