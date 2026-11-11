//! TypeScript binding for the Reflex kernel, through wasm-bindgen.
//!
//! A thin wrapper: every call forwards to `reflex_kernel::Space`. JSON crosses
//! as strings, CRDT bytes as `Uint8Array`, and times as JS numbers (ms).

use wasm_bindgen::prelude::*;

fn err(e: reflex_kernel::KernelError) -> JsError {
    JsError::new(&e.to_string())
}

fn ms(now_ms: f64) -> i64 {
    if now_ms.is_finite() {
        now_ms as i64
    } else {
        0
    }
}

/// One replica of one Space.
#[wasm_bindgen]
pub struct Space {
    inner: reflex_kernel::Space,
}

#[wasm_bindgen]
impl Space {
    pub fn create(space_id: &str, kind: &str, actor_hex: &str) -> Result<Space, JsError> {
        Ok(Space {
            inner: reflex_kernel::Space::create(space_id, kind, actor_hex).map_err(err)?,
        })
    }

    pub fn load(bytes: &[u8], actor_hex: &str) -> Result<Space, JsError> {
        Ok(Space {
            inner: reflex_kernel::Space::load(bytes, actor_hex).map_err(err)?,
        })
    }

    #[wasm_bindgen(js_name = spaceId)]
    pub fn space_id(&self) -> String {
        self.inner.space_id()
    }

    pub fn kind(&self) -> String {
        self.inner.kind()
    }

    #[wasm_bindgen(js_name = applyAgentBatch)]
    pub fn apply_agent_batch(
        &mut self,
        agent: &str,
        request_id: &str,
        batch_json: &str,
        now_ms: f64,
    ) -> Result<String, JsError> {
        self.inner
            .apply_agent_batch(agent, request_id, batch_json, ms(now_ms))
            .map_err(err)
    }

    #[wasm_bindgen(js_name = applyUserIntent)]
    pub fn apply_user_intent(
        &mut self,
        person: &str,
        device: &str,
        intent_json: &str,
        now_ms: f64,
    ) -> Result<String, JsError> {
        self.inner
            .apply_user_intent(person, device, intent_json, ms(now_ms))
            .map_err(err)
    }

    pub fn undo(&mut self, person: &str, device: &str, now_ms: f64) -> Result<String, JsError> {
        self.inner.undo(person, device, ms(now_ms)).map_err(err)
    }

    pub fn redo(&mut self, person: &str, device: &str, now_ms: f64) -> Result<String, JsError> {
        self.inner.redo(person, device, ms(now_ms)).map_err(err)
    }

    pub fn scene(&self, query_json: &str) -> Result<String, JsError> {
        self.inner.scene(query_json).map_err(err)
    }

    pub fn digest(&self) -> String {
        self.inner.digest()
    }

    #[wasm_bindgen(js_name = freezeSend)]
    pub fn freeze_send(
        &mut self,
        person: &str,
        device: &str,
        raw_json: &str,
        now_ms: f64,
    ) -> Result<String, JsError> {
        self.inner
            .freeze_send(person, device, raw_json, ms(now_ms))
            .map_err(err)
    }

    pub fn save(&self) -> Vec<u8> {
        self.inner.save()
    }

    pub fn heads(&self) -> String {
        self.inner.heads()
    }

    #[wasm_bindgen(js_name = changesSince)]
    pub fn changes_since(&self, heads_json: &str) -> Result<Vec<u8>, JsError> {
        self.inner.changes_since(heads_json).map_err(err)
    }

    pub fn receive(&mut self, bytes: &[u8]) -> Result<String, JsError> {
        self.inner.receive(bytes).map_err(err)
    }

    #[wasm_bindgen(js_name = syncMessage)]
    pub fn sync_message(&mut self, peer: &str) -> Option<Vec<u8>> {
        self.inner.sync_message(peer)
    }

    #[wasm_bindgen(js_name = receiveSyncMessage)]
    pub fn receive_sync_message(&mut self, peer: &str, msg: &[u8]) -> Result<(), JsError> {
        self.inner.receive_sync_message(peer, msg).map_err(err)
    }

    #[wasm_bindgen(js_name = receiveSyncMessageChecked)]
    pub fn receive_sync_message_checked(
        &mut self,
        peer: &str,
        msg: &[u8],
        writers_json: &str,
    ) -> Result<String, JsError> {
        self.inner
            .receive_sync_message_checked(peer, msg, writers_json)
            .map_err(err)
    }

    pub fn send(&self, send_id: &str) -> String {
        self.inner.send(send_id)
    }

    #[wasm_bindgen(js_name = resetSync)]
    pub fn reset_sync(&mut self, peer: &str) {
        self.inner.reset_sync(peer)
    }

    pub fn marks(&self, send_id: &str, query_json: &str) -> Result<String, JsError> {
        self.inner.marks(send_id, query_json).map_err(err)
    }

    pub fn revert(
        &mut self,
        by_json: &str,
        request_id: &str,
        selector_json: &str,
        now_ms: f64,
    ) -> Result<String, JsError> {
        self.inner
            .revert(by_json, request_id, selector_json, ms(now_ms))
            .map_err(err)
    }

    pub fn timeline(&self, query_json: &str) -> Result<String, JsError> {
        self.inner.timeline(query_json).map_err(err)
    }

    #[wasm_bindgen(js_name = requestAttention)]
    pub fn request_attention(
        &mut self,
        agent: &str,
        json: &str,
        now_ms: f64,
    ) -> Result<String, JsError> {
        self.inner
            .request_attention(agent, json, ms(now_ms))
            .map_err(err)
    }
}
