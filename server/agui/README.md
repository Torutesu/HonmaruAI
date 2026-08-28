# This directory is a view onto `worker/src/agui/`

The AG-UI protocol layer has one implementation, and it lives in
`worker/src/agui/` because that is what production runs.

It used to live here too, as a near-identical copy. The copies drifted the way
copies do, and the drift was not noticed until it had shipped: a code review
found that `revised` and `delegate` were missing from `ACTION_STATUS`, the fix
landed here, and the iOS app — which talks to the Worker — was unaffected by it.
The bug was fixed in the file nobody runs.

So the files below re-export rather than reimplement. Anything that belongs to
both backends is changed in `worker/src/agui/` and both get it. Anything that
belongs only to this relay is written here, next to the re-export, where the
asymmetry is visible.
