import SwiftUI

struct ContentView: View {
    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "house.fill")
                .font(.system(size: 80))
                .foregroundColor(.blue)
            
            Text("House Planner")
                .font(.largeTitle)
                .fontWeight(.bold)
            
            Text("Design your space")
                .font(.title3)
                .foregroundColor(.secondary)
            
            Spacer()
                .frame(height: 40)
            
            VStack(alignment: .leading, spacing: 12) {
                Text("To scan a room:")
                    .font(.headline)
                
                HStack(alignment: .top, spacing: 12) {
                    Text("1.")
                    Text("Open the House Planner web app on your computer")
                }
                
                HStack(alignment: .top, spacing: 12) {
                    Text("2.")
                    Text("Generate a pairing code")
                }
                
                HStack(alignment: .top, spacing: 12) {
                    Text("3.")
                    Text("Scan the QR code or open the App Clip link")
                }
            }
            .padding()
            .background(Color(.systemGray6))
            .cornerRadius(12)
            
            Spacer()
            
            Link("Open Web App", destination: URL(string: "https://app-production-1828.up.railway.app")!)
                .font(.headline)
                .padding()
                .frame(maxWidth: .infinity)
                .background(Color.blue)
                .foregroundColor(.white)
                .cornerRadius(12)
        }
        .padding()
    }
}

#Preview {
    ContentView()
}
