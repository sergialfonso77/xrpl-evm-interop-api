# TFM Interoperability API

Prototype of the UOC Master's thesis *Blockchain Network Interoperability: The Challenge of Coexisting Multiple Infrastructures*.
It offers a common REST interface to store, retrieve and verify data on the XRP Ledger and on an EVM chain (XRPL EVM),
including a cross-chain operation that stores a record on the EVM chain and anchors its SHA-256 hash on the XRP Ledger.

> Status: PAC3 in progress. T3.1–T3.4 done (environment, adapters, contract, REST API and cross-chain operation); T3.5 (tests and measurements) in progress.

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
PRIVATE_KEY=<key of the API account> forge script script/Deploy.s.sol --rpc-url <EVM_RPC_URL> --broadcast
```

Write the deployed address in `EVM_CONTRACT_ADDRESS` and the block printed by the script in `EVM_FROM_BLOCK`.
The account that deploys the contract becomes its writer, so it must be the account of `EVM_PRIVATE_KEY`.
Then test the EVM adapter:

```bash
npm run evm:smoke     # stores a record in the contract, reads it back with and without the transaction reference
```

For the XRPL EVM Testnet use `EVM_RPC_URL=https://rpc.testnet.xrplevm.org/` and `EVM_CHAIN_ID=1449000`
(test XRP from https://faucet.xrplevm.org).

XRP Ledger accounts (with the local node running and `XRPL_STANDALONE=true` in `.env`):

```bash
npm run xrpl:setup    # creates and funds the two accounts of the API; copy the output into .env
npm run xrpl:smoke    # stores a record, reads it back with and without the local store
```

For the XRPL Testnet, set `XRPL_WS_URL=wss://s.altnet.rippletest.net:51233` and `XRPL_STANDALONE=false`;
`xrpl:setup` then funds the accounts with the public faucet.

Notes on the local networks:

- In stand-alone mode, rippled only closes a ledger when it is asked to:
  `docker compose exec rippled rippled --silent ledger_accept`.
  The finality checks (SR9) can only be observed on the public test networks; they were checked manually with the
  smoke scripts there, and with simulated chains in the unit tests.
- Anvil confirms transactions immediately; its first accounts and keys are printed in `docker compose logs anvil`.

## Run

```bash
npm run dev      # starts the API (it needs EVM_CONTRACT_ADDRESS); prints the public addresses of the API (SR12)
npm test         # unit tests
npm run coverage # unit tests with a coverage report (coverage/index.html)
```

With Docker, the API can also run in a container (the contract must be deployed and `.env` filled in first):

```bash
docker compose --profile api up -d --build       # local networks + API, on http://127.0.0.1:3000
docker compose --profile testnet up -d --build   # only the API, with .env.testnet (public test networks)
docker compose --profile api up -d --force-recreate --no-deps api   # restart only the API after changing .env
```

Notes:

- Use only one Docker engine. If Docker Desktop and OrbStack run at the same time, one of them can take the
  ports of the computer while the other one runs the containers, and the scripts on the computer and the API
  in the container end up talking to different nodes. Check that both see the same block:
  `curl -s -X POST 127.0.0.1:8545 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'`.
- Anvil and rippled in stand-alone mode keep their state in memory: when their containers restart, the
  accounts and the contract disappear. Run `npm run xrpl:setup` and deploy the contract again, and update `.env`.
- Use `--no-deps` when recreating the API, so that the networks are not recreated too.

## Measurements and evidence

```bash
# With the API running with a high rate limit (RATE_LIMIT_PER_MINUTE=1000):
npm run measure -- 10 local          # 10 executions of each operation, directly and through the API
DOTENV_CONFIG_PATH=.env.testnet npm run save-evidence   # copy of the XRPL Testnet activity of the API account
```

The interface is described in [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1). Summary:

| Method | Path | Description |
|---|---|---|
| GET | `/status` | Status of the API and of each chain, warnings of low balance and pending anchors (public) |
| POST | `/records` | `{"chain": "xrpl" \| "evm", "payload": "..."}` stores a record on one chain |
| GET | `/records/:chain/:id` | Reads a record |
| POST | `/records/cross-chain` | `{"payload": "..."}` stores on the EVM chain and anchors the SHA-256 hash on the XRP Ledger (201, or 202 if the anchor is pending) |
| GET | `/records/cross-chain/:id` | Record, state and references on both chains |
| GET | `/records/cross-chain/:id/verify` | Compares the record with its anchor |

Every request to `/records` needs `X-API-Key`. Write requests also need `X-Timestamp` (Unix seconds) and a
unique `X-Nonce` (16–128 characters), and are limited per key and minute.

With the API running, `npm run api:smoke` calls every route and prints the hash of the anchor transaction.

## Independent verification (SR5)

`scripts/verify.ts` checks a cross-chain record without the API, using only public nodes and the published
addresses of the API:

```bash
XRPL_WS_URL=wss://s.altnet.rippletest.net:51233 EVM_RPC_URL=https://rpc.testnet.xrplevm.org/ \
API_XRPL_ACCOUNT=<XRP Ledger account of the API> API_EVM_CONTRACT=<RecordStore address> \
npm run verify -- <hash of the anchor transaction>
```

## Published addresses (SR12)

Records and anchors are only valid if they were written by these addresses. The verification script and the
API ignore anything written by other accounts or contracts.

| Network | Role | Address |
|---|---|---|
| XRPL Testnet | Account of the API (records and anchors) | `rJARKG5rvwjoRQ4SdnLy5fnycvWHcijDTi` |
| XRPL Testnet | Destination of the 1-drop payments that carry the memos | `rKk5t8q8ZNomWiNQdL25kCgNgXhxdPAfuW` |
| XRPL EVM Testnet (chain 1449000) | Account of the API (writer of the contract) | `0x93a6C21B2fCAfa4c7b6A80368081E30eD3C9193b` |
| XRPL EVM Testnet (chain 1449000) | `RecordStore` contract (deployed in block 9557799) | `0x6fBc2efeb952602f8447640d27Ec145c8Bb83701` |

The local networks create new accounts every time they start, so their addresses are not published. The API prints
its addresses when it starts.

## Key rotation (SR10)

The API uses one key for each chain (`XRPL_SEED` and `EVM_PRIVATE_KEY`), and each account only needs a small
balance for the fees. If a key is compromised:

- **XRPL EVM.** Create a new key, fund it, and transfer the write permission of the contract to it with the old key:
  `cast send <contract> "transferWriter(address)" <new address> --private-key <old key> --rpc-url <EVM_RPC_URL>`.
  Then write the new key in `EVM_PRIVATE_KEY`. The contract and the records do not change; from that moment the old
  key can no longer write (tested in `contracts/test/RecordStore.t.sol`, `test_TransferWriter`).
- **XRP Ledger.** The address of the API is what identifies its records and anchors. The XRP Ledger allows the
  signing key of an account to be replaced (regular key, `SetRegularKey`) while the address stays the same, but the
  adapter does not support a regular key yet (planned for PAC4). Until then, the alternative is a new account: its
  address must be published, and the records and anchors of the old address remain valid only up to the date of the
  change.

## Security notes

- Secrets are read from environment variables, normally from `.env` or `.env.testnet`, which are excluded from Git
  (SR3). They are never written in the code.
- Only test networks are used, without real funds (LR2). Nothing in the code prevents a configuration for the main
  networks, so this depends on the operator.
- Known limitations, to be studied in the threat model (PAC4): the nonce is not signed together with the content of
  the request; invalid requests also count for the rate limit; error messages can show details of the nodes; the API
  trusts a single node per chain (SR7) and has no operation log yet (SR6).

## Licence

MIT
