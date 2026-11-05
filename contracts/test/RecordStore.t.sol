// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RecordStore} from "../src/RecordStore.sol";

contract RecordStoreTest is Test {
    RecordStore store;
    address other = address(0xBEEF);

    function setUp() public {
        store = new RecordStore();
    }

    function test_StoreAndGet() public {
        bytes32 id = keccak256("record-1");
        store.store(id, "hello");
        (string memory payload,, bool exists) = store.get(id);
        assertTrue(exists);
        assertEq(payload, "hello");
    }

    function test_EmitsSha256OfPayload() public {
        bytes32 id = keccak256("record-2");
        vm.expectEmit(true, false, false, true);
        emit RecordStore.RecordStored(id, sha256(bytes("hello")));
        store.store(id, "hello");
    }

    function test_RevertWhen_NotWriter() public {
        vm.prank(other);
        vm.expectRevert(RecordStore.NotWriter.selector);
        store.store(keccak256("x"), "data");
    }

    function test_RevertWhen_Overwrite() public {
        bytes32 id = keccak256("record-3");
        store.store(id, "a");
        vm.expectRevert(abi.encodeWithSelector(RecordStore.RecordAlreadyExists.selector, id));
        store.store(id, "b");
    }

    function test_RevertWhen_PayloadTooLarge() public {
        bytes memory big = new bytes(4097);
        vm.expectRevert(abi.encodeWithSelector(RecordStore.PayloadTooLarge.selector, 4097));
        store.store(keccak256("big"), string(big));
    }

    function test_TransferWriter() public {
        store.transferWriter(other);
        assertEq(store.writer(), other);
        vm.expectRevert(RecordStore.NotWriter.selector);
        store.store(keccak256("y"), "data");
    }

    function test_UnknownRecordDoesNotExist() public view {
        (,, bool exists) = store.get(keccak256("missing"));
        assertFalse(exists);
    }
}
