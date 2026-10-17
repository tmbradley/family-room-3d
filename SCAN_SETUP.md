# Room Scanning Setup Guide

This guide covers the steps Michael needs to take to get room scanning working end-to-end.

## Overview

The room scanning feature allows you to:
1. Generate a pairing code in the web app
2. Scan a room with your iPhone using the App Clip
3. Capture photos of the room
4. Upload everything to the server
5. Review and promote the scan to become Current

## Server Setup (Already Done)

The server changes have been deployed to Railway:
- ✅ Database migration for scan imports
- ✅ Upload token endpoints
- ✅ Presigned S3 upload URLs
- ✅ RoomPlan parser
- ✅ Scan import management endpoints
- ✅ Apple App Site Association file

## iOS Setup (To Do)

### Step 1: Open the Project

On your Mac with Xcode:

```bash
cd /path/to/family-room-3d
open ios/HousePlanner.xcodeproj
```

### Step 2: Configure Code Signing

1. Select the `HousePlanner` target
2. Go to "Signing & Capabilities"
3. Set your **Team** (your Apple Developer account)
4. Verify or change the **Bundle Identifier**: `com.michaelbradley.houseplanner`

5. Select the `HousePlannerClip` target
6. Set your **Team**
7. The Bundle Identifier must be: `com.michaelbradley.houseplanner.clip`

### Step 3: Register App IDs

Go to [developer.apple.com](https://developer.apple.com) → Certificates, Identifiers & Profiles → Identifiers:

1. **Create Parent App ID**:
   - Click "+" to add a new identifier
   - Type: App IDs
   - Bundle ID: `com.michaelbradley.houseplanner` (or your chosen ID)
   - Enable capability: **App Clips**

2. **Create App Clip ID**:
   - Click "+" again
   - Type: App IDs
   - Bundle ID: `com.michaelbradley.houseplanner.clip`
   - Select: **App Clip**
   - Associate with parent app

### Step 4: Configure Associated Domains

In Xcode, for the `HousePlannerClip` target:

1. Go to "Signing & Capabilities"
2. Click "+ Capability"
3. Add "Associated Domains"
4. Add domain: `appclips:app-production-1828.up.railway.app`

### Step 5: Update Apple App Site Association

The file at `/server/public/apple-app-site-association` needs your Team ID:

```json
{
  "appclips": {
    "apps": [
      "YOUR_TEAM_ID.com.michaelbradley.houseplanner.clip"
    ]
  },
  "applinks": {
    "details": [
      {
        "appIDs": [
          "YOUR_TEAM_ID.com.michaelbradley.houseplanner.clip"
        ],
        ...
      }
    ]
  }
}
```

Replace `YOUR_TEAM_ID` with your actual Team ID (found in your Apple Developer account under Membership).

After updating, commit and push:

```bash
git add server/public/apple-app-site-association
git commit -m "Update apple-app-site-association with Team ID"
git push
```

The file will be served at:
- `https://app-production-1828.up.railway.app/.well-known/apple-app-site-association`
- `https://app-production-1828.up.railway.app/apple-app-site-association`

### Step 6: Build and Run on iPhone

1. Connect your iPhone (must have LiDAR: iPhone 12 Pro or later)
2. Select your iPhone as the build destination in Xcode
3. Click Run (⌘R)
4. The app will install on your iPhone

## Testing the App Clip Locally

Before deploying to TestFlight, test locally:

1. On your iPhone, go to **Settings** → **Developer**
2. Scroll to **Local Experiences** → **Register Local Experience**
3. Enter:
   - **URL Prefix**: `https://app-production-1828.up.railway.app/scan`
   - **Bundle ID**: `com.michaelbradley.houseplanner.clip`
4. Save

Now when you open a scan URL with a token, the App Clip will launch.

## Testing the Full Flow

### 1. Generate Pairing Code (Web App)

The web app needs a UI for generating pairing codes. For now, use curl:

```bash
# Sign in to get a session cookie first (use the web app)

# Then generate a token:
curl -X POST https://app-production-1828.up.railway.app/api/upload-tokens \
  -H "Content-Type: application/json" \
  -H "Cookie: hp_session=YOUR_SESSION_COOKIE" \
  -d '{}'
```

Response:
```json
{
  "token": "ABCD-EFGH-IJKL",
  "expiresAt": "2026-10-17T12:00:00.000Z"
}
```

### 2. Open the App Clip

On your iPhone, open Safari and go to:
```
https://app-production-1828.up.railway.app/scan?token=ABCD-EFGH-IJKL
```

The App Clip should launch (if local experience is registered).

### 3. Scan the Room

1. The App Clip validates the token
2. Tap "Start Scanning"
3. Use LiDAR to scan the room
4. Tap "Done" when finished
5. Take 4-6 photos of the room
6. Tap "Upload Scan"
7. Wait for upload to complete

### 4. Review in Web App

1. Back in the web app, fetch the scan imports:

```bash
curl https://app-production-1828.up.railway.app/api/scans \
  -H "Cookie: hp_session=YOUR_SESSION_COOKIE"
```

2. Get details of a specific scan:

```bash
curl https://app-production-1828.up.railway.app/api/scans/1 \
  -H "Cookie: hp_session=YOUR_SESSION_COOKIE"
```

3. Preview in 3D editor (UI to be built)

4. Promote to Current:

```bash
curl -X POST https://app-production-1828.up.railway.app/api/scans/1/promote \
  -H "Cookie: hp_session=YOUR_SESSION_COOKIE"
```

## Deploying to TestFlight (Optional)

When ready for field testing:

1. In Xcode: **Product** → **Archive**
2. Click **Distribute App** → **App Store Connect**
3. Follow prompts to upload
4. Once processed, install via TestFlight

## Troubleshooting

### "No such module 'RoomPlan'"

RoomPlan requires:
- iOS 17.0+ deployment target (already set)
- A physical device with LiDAR
- Xcode 15.0+

### App Clip Doesn't Launch

1. Verify the apple-app-site-association is accessible:
   ```bash
   curl https://app-production-1828.up.railway.app/.well-known/apple-app-site-association
   ```

2. Check that your Team ID is correct in the file

3. Verify Associated Domains capability is enabled

4. For local testing, check the Local Experience is registered correctly

### Upload Failures

- Ensure the pairing token is valid (60 minute expiry)
- Check S3 credentials are configured on Railway
- Verify network connectivity

### Scan Import Not Appearing

- Check Railway logs for parser errors
- Verify the RoomPlan JSON was uploaded successfully
- Ensure the scan import endpoint returned 201

## Next Steps

After successful testing:

1. Build a UI in the web editor for:
   - Generating pairing codes (with QR code)
   - Listing scan imports
   - 3D preview of scans
   - Promote/reject buttons

2. Implement the full promotion logic that:
   - Creates or updates Current room
   - Checks for pinned manual measurements
   - Records all measurements with source='scan'
   - Creates a revision

3. Add multi-room support

4. Handle rescans (propose updates without overwriting pins)

## Files Changed

### Server
- `prisma/schema.prisma` - Added scan import models
- `prisma/migrations/0004_scan_imports/migration.sql` - Migration
- `server/uploads.ts` - Upload token and S3 presigned URL logic
- `server/scans.ts` - RoomPlan parser and scan import management
- `server/app.ts` - New endpoints for pairing, uploads, and scans
- `server/public/apple-app-site-association` - App Clip configuration

### iOS
- `ios/HousePlanner.xcodeproj/` - Xcode project
- `ios/HousePlanner/` - Parent app (minimal)
- `ios/HousePlannerClip/` - App Clip (scanning, photos, uploads)
- `ios/README.md` - Detailed setup instructions

### Tests & Fixtures
- `tests/scans.test.ts` - Parser tests
- `fixtures/sample-roomplan.json` - Sample RoomPlan data
