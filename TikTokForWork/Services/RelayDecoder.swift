import Foundation

/// The decoder for anything the relay writes: cards, and events that carry a
/// card. The relay stamps dates as ISO 8601, sometimes with fractional
/// seconds and sometimes without, and a plain `JSONDecoder` reads neither
/// into a `Date` — which is why the history screen could name a card but
/// never open it.
extension JSONDecoder {
    static func relay() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            for formatter in [ISO8601DateFormatter.relayFractional, ISO8601DateFormatter.relayStandard] {
                if let date = formatter.date(from: value) { return date }
            }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid date: \(value)")
        }
        return decoder
    }
}

extension ISO8601DateFormatter {
    static let relayStandard: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static let relayFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
