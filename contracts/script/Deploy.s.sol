// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {RecordStore} from "../src/RecordStore.sol";

/// Deploys RecordStore with the key given in the PRIVATE_KEY environment variable.
contract Deploy is Script {
    function run() external {
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        RecordStore store = new RecordStore();
        vm.stopBroadcast();
        console.log("RecordStore deployed at", address(store));
    }
}
