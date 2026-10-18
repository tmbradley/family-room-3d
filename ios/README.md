# House Planner iOS: parent app + "Scan Room" App Clip

The App Clip scans a room with RoomPlan (LiDAR) and uploads it to House Planner for review. The
parent app is a minimal container; Apple requires one to ship a clip. Nothing here has been built
or run yet. It is written against the iOS 17 SDK and has to be built on a Mac (PLAN.md, P7).

| | Bundle id | Notes |
|---|---|---|
| Parent app | `com.michaelbradley.houseplanner` | Embeds the clip ("Embed App Clips" build phase) |
| App Clip | `com.michaelbradley.houseplanner.clip` | Entitlements: `appclips:app-production-1828.up.railway.app`, parent app id |

Team `Q3HHMS5MLX` is set on both targets. The server's apple-app-site-association names
`Q3HHMS5MLX.com.michaelbradley.houseplanner.clip` (from `APPLE_TEAM_ID` on Railway).

## What you need

- A Mac with Xcode 15 or newer (iOS 17 SDK)
- An iPhone with LiDAR (12 Pro or a newer Pro model) on iOS 17+, with Developer Mode on
- Your Apple Developer account signed in to Xcode (Settings → Accounts)

## Steps on your Mac

1. **Get the code**
   ```sh
   git clone https://github.com/tmbradley/family-room-3d.git   # or: git pull
   cd family-room-3d/ios
   open HousePlanner.xcodeproj
   ```
   Use the checked-in project. `project.yml` (XcodeGen) is kept in step, but you don't need it.

2. **Signing:** select the project, then each target (HousePlanner and HousePlannerClip) →
   Signing & Capabilities. Leave "Automatically manage signing" on with team Q3HHMS5MLX. Xcode
   registers both bundle ids and the clip's Associated Domains and parent-app entitlements. If a
   bundle id is taken, change the prefix on both targets and tell the bot, so the server's
   apple-app-site-association matches.

3. **Build and run the clip on your iPhone:** plug in the phone, choose the **HousePlannerClip**
   scheme and your iPhone, then press Run. You should see "Scan a room" with a code box.
   If the build fails, copy the first error back to the bot. The Swift has not been compiled
   against the iOS SDK yet.

4. **Try a scan:**
   1. In the editor (https://app-production-1828.up.railway.app, signed in with your passkey),
      click **Pair phone** under Scanning.
   2. Pick "A new room" with the name "Family room", or "Rescan <room>" for a room already in
      Current. Click **Create code**.
   3. In the clip, type the code, tap **Start scanning**, walk the room slowly, then tap **Done**.
   4. Optionally take a few photos (up to 10), then tap **Upload scan**.
   5. Back in the editor, the scan shows up under Scanning. Click **Review** to see it next to
      your room, then click **Promote to Current** (or Reject). The first promote creates Current.
      Promoting again with a rescan updates the matched walls and doors. Pinned values always win.
      Every promote can be rolled back from History while the Current tab is focused.

5. **Invoking the clip from the QR code (optional, for later):** a QR code only opens the clip
   once Apple knows about it. While you're developing, go to Settings → Developer → App Clips
   Testing → Local Experiences on the iPhone, then register
   `https://app-production-1828.up.railway.app/scan` for bundle id
   `com.michaelbradley.houseplanner.clip`. After that, scanning the QR from **Pair phone** opens
   the clip with the code filled in. For other people's phones, upload a build to App Store Connect
   / TestFlight and add an App Clip experience for the same URL.

6. **TestFlight (optional):** choose the **HousePlanner** scheme and Any iOS Device, then
   Product → Archive → Distribute App → App Store Connect. The clip ships inside the parent app.

## How it talks to the server

The clip only ever holds the pairing code. It has no session and no agent key.

1. `POST /api/upload-tokens/validate {token}` returns the scope, room label and uploads left.
2. For each file (RoomPlan JSON, parametric USDZ, photos): `POST /api/uploads/presigned
   {token, kind, format}`, then a PUT to the returned URL with the returned Content-Type, then
   `POST /api/uploads/:id/complete {token, bytes}`.
3. `POST /api/scans/import {token, uploadId, roomplanData}` creates a pending scan import and
   spends the code.

Codes are hashed on the server. They expire after 60 minutes, allow 12 files, and are bound to
one room scope. Uploads belong to the code that created them. Promote and Reject need your
passkey session.

## Files

- `HousePlannerClip/RoomPlanCapture.swift`: `RoomScanController`. It owns a `RoomCaptureView`,
  starts and stops `captureView.captureSession`, and receives the processed `CapturedRoom`
  through `RoomCaptureViewDelegate`.
- `HousePlannerClip/ScanView.swift`: the screens (code entry, scanning, review and photos,
  uploading, done).
- `HousePlannerClip/UploadManager.swift`: the API calls above. The base URL comes from the
  invocation URL and defaults to production.
- `HousePlannerClip/Info.plist`: camera usage string, `NSAppClip`, and the ARKit requirement.
  Xcode generates the rest.
- `HousePlanner/`: the minimal parent app.
