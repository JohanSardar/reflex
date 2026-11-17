import Foundation

/// An Agent waiting for the person to approve it, sent by the Link.
public struct AgentRequest: Identifiable, Sendable, Equatable {
    public var id: String
    public var name: String
    public var color: String
    /// When the Link asked (ms). An answer is for this request only: asked again later, it is a new question.
    public var requestedAt: Int64?
}

/// Another iPad of the person's waiting for "Let … approve Agents?" (asked of approving iPads only).
public struct ApproverRequest: Identifiable, Sendable, Equatable {
    public var device: String
    public var name: String
    public var id: String { device }
}

/// The person's answer to one request, kept until the Link confirms it.
public struct AgentDecision: Codable, Sendable, Equatable {
    public var status: String
    public var requestedAt: Int64?
}

/// An Agent the Link knows: its name and color, for its chip and the history.
public struct AgentInfo: Codable, Identifiable, Sendable, Equatable {
    public var id: String
    public var name: String
    /// A named protocol color.
    public var color: String
    public var status: String
    public var requestedAt: Int64?
}
