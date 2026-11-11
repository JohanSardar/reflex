# Reflex

A Pencil-first canvas on iPad that any AI agent can draw on, build on, and read from, and that the user can write, speak, and tap on to talk back to the agent.

## Spaces and content

**Space**:
One named shared surface, with its own Elements, that the user and one or more Agents work on together; a user has many Spaces and switches between them.
_Avoid_: canvas (as a countable noun), board, whiteboard, page, document

**Agent**:
One approved writer from an agent harness, with a stable name and color that persist across reconnects.
_Avoid_: harness, bot, client, session

**Element**:
Any one object placed in a Space, whoever placed it.
_Avoid_: shape, node, object, item

**Ink**:
Freehand Pencil or finger strokes, kept as strokes rather than flattened pixels.
_Avoid_: drawing, scribble, annotation

**Mark**:
A group of the user's Ink strokes read as one gesture with a meaning, such as a circle, strikethrough, arrow or nearby writing.
_Avoid_: annotation, gesture, scribble

**Anchor**:
What a Mark refers to, captured when the Mark was drawn: an Element, plus where on it, such as a text range, data rows, a DOM node, a 3D part or local coordinates.
_Avoid_: target, reference, attachment

**Embed**:
An Element that renders content Reflex does not natively understand, such as HTML or a 3D model.
_Avoid_: widget, iframe, plugin

**Panel**:
Native interface (a sidebar, form, buttons, choice chips) that the agent declares and Reflex renders, usually opened from an Element.
_Avoid_: sidebar, popup, modal

**Behavior**:
A rule attached to an Element that says what happens when someone interacts with it, such as opening a Panel on tap.
_Avoid_: action, handler, interaction

**Region**:
An area of a Space with its own rules, such as whether Ink is allowed there.
_Avoid_: zone, area, frame

## Talking back to the agent

**Send**:
The user's deliberate act of handing their work back to the agent; it ends the user's turn.
_Avoid_: submit, prompt, message

**Send Bundle**:
Everything one Send carries back to the agent: what changed, an image, the structured scene, and any voice transcript.
_Avoid_: payload, snapshot, context

**Inbox**:
The queue where Send Bundles wait until an agent picks them up, so a Send is never lost when no agent is listening.
_Avoid_: queue, mailbox

**Send Adapter**:
One way of delivering a Send Bundle to a particular kind of agent harness.
_Avoid_: connector, integration, driver

## Connections

**Reflex Link**:
The companion process on the user's computer that local Agents connect through and that keeps a replica of the user's Spaces.
_Avoid_: bridge, host, daemon, hub

**Relay**:
The hosted service that lets Agents and devices outside the local network reach a Space.
_Avoid_: cloud, server, backend

## Extending Reflex

**Guide**:
On-demand instructions that teach Agents to use Reflex for a domain or an Element type.
_Avoid_: docs, prompt, skill

**Recipe**:
A ready-made, parameterized pattern of Elements, Regions, Panels and Behaviors that an Agent applies in one call.
_Avoid_: template, macro, snippet

**Embed Template**:
A reusable Embed, packaged with its parameters, Guide and Anchor registration, that anyone can add without an app release.
_Avoid_: widget, plugin, component

