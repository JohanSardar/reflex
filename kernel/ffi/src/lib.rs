//! Swift binding for the Reflex kernel, through UniFFI.
//!
//! A thin wrapper: every call forwards to `reflex_kernel::Space`. JSON crosses
//! as strings and CRDT bytes as byte arrays.

use std::sync::{Arc, Mutex, MutexGuard};

uniffi::setup_scaffolding!();

#[derive(Debug, uniffi::Error)]
#[uniffi(flat_error)]
pub enum KernelError {
    BadJson(String),
    BadBytes(String),
    BadArgument(String),
}

impl std::fmt::Display for KernelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KernelError::BadJson(m) => write!(f, "bad JSON: {m}"),
            KernelError::BadBytes(m) => write!(f, "bad bytes: {m}"),
            KernelError::BadArgument(m) => write!(f, "bad argument: {m}"),
        }
    }
}

impl From<reflex_kernel::KernelError> for KernelError {
    fn from(e: reflex_kernel::KernelError) -> Self {
        match e {
            reflex_kernel::KernelError::BadJson(m) => KernelError::BadJson(m),
            reflex_kernel::KernelError::BadBytes(m) => KernelError::BadBytes(m),
            reflex_kernel::KernelError::BadArgument(m) => KernelError::BadArgument(m),
        }
    }
}

type R<T> = Result<T, KernelError>;

/// One replica of one Space.
#[derive(uniffi::Object)]
pub struct Space(Mutex<reflex_kernel::Space>);

impl Space {
    fn lock(&self) -> MutexGuard<'_, reflex_kernel::Space> {
        // A panic inside the kernel poisons the lock; the state is still the
        // last committed one, because every write is one transaction.
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
}

#[uniffi::export]
impl Space {
    #[uniffi::constructor]
    pub fn create(space_id: String, kind: String, actor_hex: String) -> R<Arc<Self>> {
        Ok(Arc::new(Space(Mutex::new(reflex_kernel::Space::create(
            &space_id, &kind, &actor_hex,
        )?))))
    }

    #[uniffi::constructor]
    pub fn load(bytes: Vec<u8>, actor_hex: String) -> R<Arc<Self>> {
        Ok(Arc::new(Space(Mutex::new(reflex_kernel::Space::load(
            &bytes, &actor_hex,
        )?))))
    }

    pub fn space_id(&self) -> String {
        self.lock().space_id()
    }

    pub fn kind(&self) -> String {
        self.lock().kind()
    }

    pub fn apply_agent_batch(
        &self,
        agent: String,
        request_id: String,
        batch_json: String,
        now_ms: i64,
    ) -> R<String> {
        Ok(self
            .lock()
            .apply_agent_batch(&agent, &request_id, &batch_json, now_ms)?)
    }

    pub fn apply_user_intent(
        &self,
        person: String,
        device: String,
        intent_json: String,
        now_ms: i64,
    ) -> R<String> {
        Ok(self
            .lock()
            .apply_user_intent(&person, &device, &intent_json, now_ms)?)
    }

    pub fn undo(&self, person: String, device: String, now_ms: i64) -> R<String> {
        Ok(self.lock().undo(&person, &device, now_ms)?)
    }

    pub fn redo(&self, person: String, device: String, now_ms: i64) -> R<String> {
        Ok(self.lock().redo(&person, &device, now_ms)?)
    }

    pub fn scene(&self, query_json: String) -> R<String> {
        Ok(self.lock().scene(&query_json)?)
    }

    pub fn digest(&self) -> String {
        self.lock().digest()
    }

    pub fn freeze_send(
        &self,
        person: String,
        device: String,
        raw_json: String,
        now_ms: i64,
    ) -> R<String> {
        Ok(self
            .lock()
            .freeze_send(&person, &device, &raw_json, now_ms)?)
    }

    pub fn save(&self) -> Vec<u8> {
        self.lock().save()
    }

    pub fn heads(&self) -> String {
        self.lock().heads()
    }

    pub fn changes_since(&self, heads_json: String) -> R<Vec<u8>> {
        Ok(self.lock().changes_since(&heads_json)?)
    }

    pub fn receive(&self, bytes: Vec<u8>) -> R<String> {
        Ok(self.lock().receive(&bytes)?)
    }

    pub fn sync_message(&self, peer: String) -> Option<Vec<u8>> {
        self.lock().sync_message(&peer)
    }

    pub fn receive_sync_message(&self, peer: String, msg: Vec<u8>) -> R<()> {
        Ok(self.lock().receive_sync_message(&peer, &msg)?)
    }

    pub fn receive_sync_message_checked(
        &self,
        peer: String,
        msg: Vec<u8>,
        writers_json: String,
    ) -> R<String> {
        Ok(self
            .lock()
            .receive_sync_message_checked(&peer, &msg, &writers_json)?)
    }

    pub fn send(&self, send_id: String) -> String {
        self.lock().send(&send_id)
    }

    pub fn reset_sync(&self, peer: String) {
        self.lock().reset_sync(&peer)
    }

    pub fn marks(&self, send_id: String, query_json: String) -> R<String> {
        Ok(self.lock().marks(&send_id, &query_json)?)
    }

    pub fn revert(
        &self,
        by_json: String,
        request_id: String,
        selector_json: String,
        now_ms: i64,
    ) -> R<String> {
        Ok(self
            .lock()
            .revert(&by_json, &request_id, &selector_json, now_ms)?)
    }

    pub fn timeline(&self, query_json: String) -> R<String> {
        Ok(self.lock().timeline(&query_json)?)
    }

    pub fn request_attention(&self, agent: String, json: String, now_ms: i64) -> R<String> {
        Ok(self.lock().request_attention(&agent, &json, now_ms)?)
    }
}
