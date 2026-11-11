//! The Reflex Protocol types, generated from `protocol/schema/` by
//! `protocol/scripts/gen-rust.mjs`. The kernel parses `apply` ops and projects
//! scene Elements through these types, so it accepts and returns exactly the
//! shapes in `protocol/`.

include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../protocol/generated/rust/protocol.rs"
));
