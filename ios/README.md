# House Planner iOS App & App Clip

This directory contains the iOS app with an App Clip for scanning rooms using LiDAR and RoomPlan.

## Requirements

- macOS with Xcode 15.0 or later
- Apple Developer account (for code signing and TestFlight)
- iPhone with LiDAR (iPhone 12 Pro or later, iOS 17.0+)

## Project Structure

- `HousePlanner/` - Parent iOS app (minimal, required for App Clip)
- `HousePlannerClip/` - App Clip for room scanning
- `HousePlanner.xcodeproj` - Xcode project file (hand-written)
- `project.yml` - XcodeGen spec (fallback, more reliable)

## Setup Instructions

### 1. Open the Project in Xcode

**Option A: Use the hand-written project (try this first)**

```bash
open ios/HousePlanner.xcodeproj
```

If Xcode shows errors opening the project, use Option B.

**Option B: Generate from XcodeGen spec (more reliable)**

```bash
cd ios
brew install xcodegen  # One-time install
xcodegen generate
open HousePlanner.xcodeproj
```

The `project.yml` spec is checked in and generates the same project structure.

### 2. Configure Code Signing

1. Select the `HousePlanner` target in the project navigator
2. Go to "Signing & Capabilities"
3. Set your **Team** (your Apple Developer account)
4. Change the **Bundle Identifier** if needed (default: `com.michaelbradley.houseplanner`)

5. Repeat for the `HousePlannerClip` target:
   - Set your **Team**
   - The Bundle Identifier must be the parent app's ID + `.clip` (e.g., `com.michaelbradley.houseplanner.clip`)

### 3. Register App IDs in Apple Developer Portal

1. Go to [developer.apple.com](https://developer.apple.com)
2. Navigate to **Certificates, Identifiers & Profiles** → **Identifiers**
3. Create two App IDs:
   - **Parent app**: `com.michaelbradley.houseplanner` (or your chosen ID)
     - Enable "App Clips" capability
   - **App Clip**: `com.michaelbradley.houseplanner.clip`
     - Select "App Clip" type
     - Associate with the parent app

### 4. Configure Associated Domains (for App Clip invocation)

In Xcode, for the `HousePlannerClip` target:

1. Go to "Signing & Capabilities"
2. Click "+ Capability" and add "Associated Domains"
3. Add the domain: `appclips:app-production-1828.up.railway.app`

The server already serves the `apple-app-site-association` file at:
```
https://app-production-1828.up.railway.app/.well-known/apple-app-site-association
```

### 5. Build and Run on Your iPhone

1. Connect your iPhone to your Mac
2. Select your iPhone as the build destination
3. Click the Run button (⌘R)
4. The app will install and launch on your iPhone

### 6. Test the App Clip Locally

To test the App Clip without deploying to TestFlight:

1. On your iPhone, go to **Settings** → **Developer**
2. Scroll to **Local Experiences** → **Register Local Experience**
3. Enter:
   - **URL Prefix**: `https://app-production-1828.up.railway.app/scan`
   - **Bundle ID**: Your App Clip bundle ID
4. Save

Now when you open the scan URL with a pairing token (from the web app), the App Clip will launch.

### 7. Archive and Upload to TestFlight (Optional)

When ready to distribute via TestFlight:

1. In Xcode, select **Product** → **Archive**
2. Once the archive completes, the Organizer window opens
3. Click **Distribute App** → **App Store Connect**
4. Follow the prompts to upload to TestFlight
5. Once processing completes in App Store Connect, you can test via TestFlight

## Usage Flow

### From the Web App (Signed In):

1. Michael generates a pairing code in the web app
2. The web app shows a QR code and URL: `https://app-production-1828.up.railway.app/scan?token=XXXX-YYYY-ZZZZ`
3. Scan the QR code or tap the URL on the iPhone
4. The App Clip launches with the pairing token
5. Michael scans the room with RoomPlan
6. Captures 4-6 photos of the room
7. The App Clip uploads everything to the server
8. Back in the web app, the scan appears as a reviewable import

### From the Full App:

The parent app provides:
- Instructions for using the App Clip
- A link to the web app
- A simple room viewer (future)

## Key Files

- **HousePlannerClipApp.swift** - App Clip entry point, handles URL activation
- **ScanView.swift** - Main UI for scanning flow
- **RoomPlanCapture.swift** - RoomPlan capture session wrapper
- **UploadManager.swift** - Handles token validation and file uploads
- **Info.plist** - App Clip configuration and camera permissions

## App Clip Size Limit

App Clips must be under 15 MB uncompressed. This project is well within that limit as it only uses:
- SwiftUI
- RoomPlan (system framework)
- Foundation / UIKit

## Troubleshooting

### "No such module 'RoomPlan'"

RoomPlan requires:
- iOS 17.0+ deployment target
- A physical device with LiDAR (won't build for simulator)
- Xcode 15.0+

### Code Signing Errors

Make sure:
- Your Apple Developer account is active
- You've registered both App IDs in the Developer Portal
- The parent app has "App Clips" capability enabled
- The App Clip's Bundle ID is parent + `.clip`

### App Clip Doesn't Launch

1. Verify the `apple-app-site-association` file is accessible at:
   ```
   https://app-production-1828.up.railway.app/.well-known/apple-app-site-association
   ```
2. Check that Associated Domains are configured correctly
3. For local testing, use the Local Experiences feature in Settings → Developer

### Upload Failures

- Ensure the pairing token is valid (check expiration)
- Check network connectivity
- Verify the Railway API is accessible from the iPhone
- Look for error messages in the App Clip UI

## Development Notes

- The App Clip uses URLSession with presigned S3 URLs for uploads
- Scans are persisted locally until upload succeeds (stored in temporary directory)
- The pairing token is validated before scanning begins
- Progress updates are shown during upload

## Next Steps

After successful scanning:
1. View the scan import in the web editor
2. Preview in 3D
3. Fix any issues with existing tools
4. Click "Promote to Current" to create the locked Current version
5. Rescan later to propose updates (respects pinned manual measurements)
