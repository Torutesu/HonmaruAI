import AVKit
import SwiftUI

/// The clip the sender recorded while speaking the decision.
///
/// It starts muted and paused behind a poster tap rather than autoplaying: a
/// feed that talks at you the moment it appears is the thing this product is
/// supposed to be an alternative to.
struct CardVideoView: View {
    let urlString: String

    @State private var player: AVPlayer?
    @State private var failed = false

    var body: some View {
        Group {
            if let player {
                VideoPlayer(player: player)
                    .frame(height: 190)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image))
            } else {
                poster
            }
        }
        .onDisappear {
            player?.pause()
        }
    }

    private var poster: some View {
        Button {
            guard let url = MediaStore.playableURL(from: urlString) else {
                failed = true
                return
            }
            let player = AVPlayer(url: url)
            player.isMuted = false
            self.player = player
            player.play()
        } label: {
            ZStack {
                RoundedRectangle(cornerRadius: Theme.Radius.image)
                    .fill(Theme.Colors.surface)
                    .frame(height: 190)
                    .overlay {
                        RoundedRectangle(cornerRadius: Theme.Radius.image)
                            .strokeBorder(Theme.Colors.border, lineWidth: 1)
                    }

                VStack(spacing: 8) {
                    Image(systemName: failed ? "exclamationmark.triangle" : "play.circle.fill")
                        .font(.system(size: 34))
                        .foregroundStyle(failed ? Theme.Colors.textTertiary : Theme.Colors.textPrimary)
                    Text(failed ? String(localized: "Can't load the video") : String(localized: "Watch recording"))
                        .font(Theme.TypeScale.caption)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(failed)
    }
}
