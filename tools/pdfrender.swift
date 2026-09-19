import PDFKit
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

// usage: pdfrender <file.pdf> <outDir> [page] [scale]
// Renders one page (default 1) to PNG at given scale (default 2.0).
let args = CommandLine.arguments
guard args.count >= 3 else { fputs("usage: pdfrender <file.pdf> <outDir> [page] [scale]\n", stderr); exit(2) }
let url = URL(fileURLWithPath: (args[1] as NSString).expandingTildeInPath)
let outDir = URL(fileURLWithPath: (args[2] as NSString).expandingTildeInPath)
guard let doc = PDFDocument(url: url), let page = doc.page(at: (args.count > 3 ? max(1, Int(args[3]) ?? 1) : 1) - 1) else {
    fputs("ERROR: cannot open pdf or page\n", stderr); exit(1)
}
let scale: CGFloat = args.count > 4 ? CGFloat(Double(args[4]) ?? 2.0) : 2.0
let bounds = page.bounds(for: .mediaBox)
let w = Int(bounds.width * scale), h = Int(bounds.height * scale)

guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                          space: CGColorSpaceCreateDeviceRGB(),
                          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { exit(1) }
ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
ctx.scaleBy(x: scale, y: scale)
ctx.translateBy(x: -bounds.origin.x, y: -bounds.origin.y)
page.draw(with: .mediaBox, to: ctx)

guard let img = ctx.makeImage() else { exit(1) }
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
let pageNum = args.count > 3 ? (Int(args[3]) ?? 1) : 1
let out = outDir.appendingPathComponent("page-\(pageNum).png")
guard let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.png.identifier as CFString, 1, nil) else { exit(1) }
CGImageDestinationAddImage(dest, img, nil)
CGImageDestinationFinalize(dest)
print(out.path)
