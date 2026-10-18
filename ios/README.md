# House Planner for iPhone

One full iOS app (no App Clip). Team `Q3HHMS5MLX`, bundle id `com.michaelbradley.houseplanner`,
iOS 17+, LiDAR iPhone for scanning and Object Capture. Distributed through TestFlight, built and
uploaded from Xcode on Michael's Mac (no CI, no remote builders).

## What it does

Every action starts from a pairing code made in the web editor (QR code or typed). The app has no
login, no session and never sees an agent key.

- **Scan a room** (editor: *Pair phone*): RoomPlan capture → guided photo prompts (overview, walls,
  windows and trim, doors, outlets, floor, ceiling, fireplace, furniture), each with an optional
  note → upload. Photos are sent with the same code before the import, so the server links them to
  the scan and its room (`scan_photos`). The scan then waits in the editor under *Scanning*.
- **Tape-measure notes** (same code, after the room is in Current): type notes like
  `Ceiling 8' 2". Window 61 wide, sill 30.` They become measurement suggestions, sent as one
  proposal that only Michael can approve.
- **Capture this piece** (editor: select furniture → *Capture this piece*): `ObjectCaptureSession` +
  `ObjectCaptureView` to take the images, then `PhotogrammetrySession` builds a USDZ on the phone.
  It is uploaded and attached to that placement as one revision (roll back from History).
- **On-device text** (`OnDeviceAI.swift`): with iOS 26 and Apple Intelligence, Apple's Foundation
  Models framework writes object labels from RoomPlan category + size, tags photos by room/topic from
  their notes, and turns notes into structured measurements. Every call is behind
  `#if canImport(FoundationModels)`, `if #available(iOS 26.0, *)` and
  `SystemLanguageModel.default.availability`; otherwise simple rules are used, so the app works
  the same on iOS 17-25.

## Files

| File | Purpose |
|---|---|
| `HousePlannerApp.swift` | App entry; handles the universal link `https://…/scan?token=…` |
| `ContentView.swift` | Code entry and routing by the code's purpose |
| `PlannerClient.swift` | Pairing-code API client (validate, presign → PUT → complete, import, models, suggestions) |
| `RoomPlanCapture.swift` | `RoomCaptureView` wrapper |
| `ScanFlow.swift` | Scan → guided photos → review → upload |
| `MeasureNotesView.swift` | Notes → measurement suggestions → proposal |
| `ObjectCaptureFlow.swift` | Object Capture + photogrammetry → USDZ upload |
| `OnDeviceAI.swift` | Foundation Models helpers with fallbacks |
| `HousePlanner.entitlements` | Associated Domains: `applinks:app-production-1828.up.railway.app` |

`project.yml` is the XcodeGen spec for the same project (`xcodegen generate` recreates
`HousePlanner.xcodeproj` if ever needed; the checked-in project is already up to date).

## Michael: build and run

1. **Re-pull:** `cd family-room-3d && git pull` (the old `HousePlannerClip` folder and target are gone).
2. **Delete the old App Clip from the iPhone** if it is still there: long-press the *Scan Room* clip in
   the App Library → Delete App Clip (Settings → App Clips also lists it). It was the old
   `….houseplanner.clip` build; links no longer open it.
3. Open `ios/HousePlanner.xcodeproj` in Xcode (Xcode 26 to get the Foundation Models features;
   Xcode 15/16 also builds, the on-device model code is then compiled out).
4. If Xcode still remembers the old scheme, pick **HousePlanner** in the scheme menu (Manage
   Schemes… → delete a stale *HousePlannerClip* entry if shown).
5. Target HousePlanner → Signing & Capabilities: team **Q3HHMS5MLX**, automatic signing.
   *Associated Domains* should show `applinks:app-production-1828.up.railway.app`. If Xcode says the
   capability isn't on the App ID, click the fix button (automatic signing adds it).
6. Choose your iPhone and **Run** the **HousePlanner** scheme.
7. In the web editor, click *Pair phone* and scan the QR code with the Camera app: the app opens
   with the code. (You can also type the code in the app.)

### TestFlight

Product → Archive (scheme HousePlanner, Any iOS Device) → Distribute App → App Store Connect →
Upload. Then add the build to your TestFlight group in App Store Connect. Bump
`CURRENT_PROJECT_VERSION` for each upload.

## Server side

`/.well-known/apple-app-site-association` lists only `applinks` for
`Q3HHMS5MLX.com.michaelbradley.houseplanner` and the `/scan` path with a `token` query (from
`APPLE_TEAM_ID`). iOS caches the file through Apple's CDN; after installing a new build it can take
a little while before QR links open the app instead of Safari. Typing the code always works.
