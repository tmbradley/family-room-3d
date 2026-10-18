import SwiftUI

/// Home: pair with a code (QR / link from the editor, or typed), then go to what the code is for:
/// a room scan with photos, tape-measure notes for a room, or capturing one piece of furniture.
struct ContentView: View {
    @EnvironmentObject var client: PlannerClient
    @State private var manualCode = ""

    var body: some View {
        NavigationStack {
            Group {
                if let info = client.info, info.valid || info.canSuggestMeasurements {
                    paired(info)
                } else {
                    pairing
                }
            }
            .toolbar {
                if client.token != nil {
                    ToolbarItem(placement: .topBarTrailing) { Button("New code") { client.clear() } }
                }
            }
        }
    }

    private var pairing: some View {
        VStack(spacing: 20) {
            Image(systemName: "house.fill").font(.system(size: 64)).foregroundStyle(.blue)
            Text("House Planner").font(.largeTitle.bold())
            Text("In the editor on your computer, click Pair phone (or Capture this piece on a furniture item) and scan the QR code with the Camera app, or type the code here.")
                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
            switch client.codeState {
            case .checking: ProgressView("Checking code…")
            case .invalid(let message): Text(message).font(.callout).foregroundStyle(.orange)
            case .valid(let info) where info.spent: Text("That code has been used. Make a new one in the editor.").font(.callout).foregroundStyle(.orange)
            default: EmptyView()
            }
            HStack {
                TextField("XXXX-XXXX-XXXX", text: $manualCode)
                    .textInputAutocapitalization(.characters).autocorrectionDisabled()
                    .font(.title3.monospaced()).textFieldStyle(.roundedBorder)
                Button("Use code") { client.setToken(manualCode) }
                    .disabled(manualCode.trimmingCharacters(in: .whitespaces).count < 12)
            }
            Link("Open the editor", destination: URL(string: "https://app-production-1828.up.railway.app")!).padding(.top, 12)
        }
        .padding()
    }

    @ViewBuilder private func paired(_ info: PlannerClient.TokenInfo) -> some View {
        if info.purpose == "model" {
            ObjectCaptureFlowView()
        } else if info.valid {
            ScanFlowView()
                .toolbar {
                    if info.canSuggestMeasurements {
                        ToolbarItem(placement: .topBarLeading) { NavigationLink("Measure") { MeasureNotesView() } }
                    }
                }
        } else {
            // Scan already sent with this code: it can still carry measurement notes until it expires.
            MeasureNotesView()
        }
    }
}
