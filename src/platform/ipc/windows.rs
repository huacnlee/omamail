//! Windows named pipes require an explicit current-user DACL and verified peer
//! identity, bounded frames and deadlines. The outbox adapter refuses operation
//! until those native guarantees are implemented and tested.
