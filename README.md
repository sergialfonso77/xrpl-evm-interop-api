# TFM Interoperability API

Prototype of the UOC Master's thesis *Blockchain Network Interoperability: The Challenge of Coexisting Multiple Infrastructures*.
It offers a common REST interface to store, retrieve and verify data on the XRP Ledger and on an EVM chain (XRPL EVM),
including a cross-chain operation that stores a record on the EVM chain and anchors its SHA-256 hash on the XRP Ledger.

> Status: PAC3 in progress. T3.1 (environment set-up) done; adapters and routes are added in T3.2–T3.4.

## Requirements

- Node.js 20 or later
- Docker (Docker Desktop on macOS) for the local networks
- Foundry (`forge`) for the smart contract: https://getfoundry.sh

## Structure

```
src/            API (TypeScript, Express)
  adapters/     one adapter per chain (Adapter pattern, NFR2)
  domain/       data model and hashing
  store/        local SQLite store (states, nonces)
contracts/      RecordStore smart contract (Solidity, Foundry)
docker/         configuration of the local rippled node
test/           unit tests (Vitest)
```

## Set-up

```bash
npm install
cp .env.example .env          # then fill in the values
docker compose up -d          # local rippled (stand-alone) and Anvil
```

Contract (in `contracts/`):

```bash
cd contracts
forge install foundry-rs/forge-std --no-git
forge test
PRIVATE_KEY=<anvil key> forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

Write the deployed address in `EVM_CONTRACT_ADDRESS`.

Notes on the local networks:

- In stand-alone mode, rippled only closes a ledger when it is asked to:
  `docker compose exec rippled rippled --silent ledger_accept`.
  The finality checks (SR9) are tested on the public test networks.
- Anvil confirms transactions immediately; its first accounts and keys are printed in `docker compose logs anvil`.

## Run

```bash
npm run dev      # development
npm test         # unit tests
```

## Security notes

- Secrets are only read from `.env`, which is excluded from Git (SR3).
- Only test networks are used, without real funds (LR2).

## Licence

MIT
