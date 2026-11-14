# Reflex

The person's iPad marks, words and screen sent to an approved coding agent.

## Language

**Person**:
The human who marks, writes or speaks on the iPad and decides which agents may receive their Sends.
_Avoid_: account, member

**Agent**:
An approved receiver in Claude Code or Codex, with a stable identity across reconnects.
_Avoid_: writer, bot

**Send**:
One deliberate message containing the person's marks, words and screen at the moment they press Send.
_Avoid_: change, sync event

**Mark**:
A group of the person's ink strokes, such as a circle, arrow or handwritten note.
_Avoid_: element, shape

**Space**:
A named working surface on the person's iPad from which they send input to an agent.
_Avoid_: shared workspace, room

**Link**:
The Mac companion that connects the paired iPad to approved local agents.
_Avoid_: cloud agent, viewer

**Relay**:
The optional connection route between paired devices that cannot reach each other directly.
_Avoid_: cloud storage, agent host

**Inbox**:
The Sends waiting for an approved receiver to acknowledge them.
_Avoid_: encrypted log, history

**Pairing**:
The person's act of connecting an iPad to their Mac Link.
_Avoid_: agent approval

**Agent approval**:
The person's permission for a particular agent to receive Sends.
_Avoid_: pairing, sign-in
