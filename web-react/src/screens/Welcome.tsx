import React from 'react'

interface Props {
  onStart: () => void
  onSignIn: () => void
}

/// The first screen. It has one job: say what happens when you open this app
/// tomorrow morning, in one sentence, and then get out of the way.
export const Welcome: React.FC<Props> = ({ onStart, onSignIn }) => (
  <div className="screen welcome">
    <div className="screen-body welcome-body">
      <div className="brandmark" aria-hidden="true">
        <span />
      </div>
      <h1 className="display welcome-display">
        The decision is<br />already waiting.
      </h1>
      <p className="lede">
        You talk to your own AI. It works out who needs to decide what, and
        their AI puts it in front of them as a card they can clear in a swipe.
        No channels. No inbox. No “did you see my message?”.
      </p>
      <ul className="welcome-points">
        <li><b>One feed</b><span>Everything waiting on you, most urgent first.</span></li>
        <li><b>Ten businesses, ten people</b><span>Every decision filed under the right one, in the background.</span></li>
        <li><b>In your language</b><span>Notifications arrive written in the language you read.</span></li>
      </ul>
    </div>
    <div className="screen-foot bare">
      <button className="btn btn-primary" onClick={onStart}>Get started</button>
      <button className="btn btn-quiet" onClick={onSignIn}>I already have an account</button>
    </div>
  </div>
)
