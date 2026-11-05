// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RecordStore
/// @notice Minimal storage contract of the API (Section 3.2.2).
/// Only the current writer (the account of the API) can store records; anyone can read them.
/// The write permission can be transferred to a new key if the current one is compromised (SR10).
contract RecordStore {
    struct Record {
        string payload;
        uint64 timestamp;
        bool exists;
    }

    /// @notice Maximum payload size in bytes, also enforced by the API (SR2).
    uint256 public constant MAX_PAYLOAD_BYTES = 4096;

    address public writer;
    mapping(bytes32 => Record) private records;

    event RecordStored(bytes32 indexed id, bytes32 contentHash);
    event WriterTransferred(address indexed previousWriter, address indexed newWriter);

    error NotWriter();
    error RecordAlreadyExists(bytes32 id);
    error PayloadTooLarge(uint256 size);
    error InvalidWriter();

    modifier onlyWriter() {
        if (msg.sender != writer) revert NotWriter();
        _;
    }

    constructor() {
        writer = msg.sender;
        emit WriterTransferred(address(0), msg.sender);
    }

    /// @notice Stores a record. Records cannot be overwritten.
    function store(bytes32 id, string calldata payload) external onlyWriter {
        if (records[id].exists) revert RecordAlreadyExists(id);
        uint256 size = bytes(payload).length;
        if (size > MAX_PAYLOAD_BYTES) revert PayloadTooLarge(size);
        records[id] = Record(payload, uint64(block.timestamp), true);
        // The event carries the SHA-256 hash of the payload, so that it can be compared
        // with the hash anchored on the XRP Ledger (independent verification, SR5).
        emit RecordStored(id, sha256(bytes(payload)));
    }

    /// @notice Returns a record. Reverts nothing: `exists` is false if the record is unknown.
    function get(bytes32 id) external view returns (string memory payload, uint64 timestamp, bool exists) {
        Record storage r = records[id];
        return (r.payload, r.timestamp, r.exists);
    }

    /// @notice Transfers the write permission to a new key (SR10).
    function transferWriter(address newWriter) external onlyWriter {
        if (newWriter == address(0)) revert InvalidWriter();
        emit WriterTransferred(writer, newWriter);
        writer = newWriter;
    }
}
