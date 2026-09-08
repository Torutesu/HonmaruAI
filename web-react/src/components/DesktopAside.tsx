import React from 'react'

/// What sits beside the app on a wide screen.
///
/// The product is a phone app and every screen in it is 430px wide. Left
/// alone on a laptop that reads as a broken strip in a field of white, so
/// this names the column rather than stretching it — a decision card 1200px
/// wide would be a worse card.
///
/// Hidden below 1440px, and `aria-hidden` because it repeats what the screen
/// beside it already says; a screen reader should reach the app, not this.
export const DesktopAside: React.FC = () => (
  <aside className="desk-aside" aria-hidden="true">
    <div className="desk-mark" />
    <h1>Honmaru AI</h1>
    <p>
      The decision feed for a team of under ten running ten businesses.
      Everything waiting on you, and nothing else.
    </p>
    <ul>
      <li>No channels</li>
      <li>No inbox</li>
      <li>In your language</li>
    </ul>
  </aside>
)
