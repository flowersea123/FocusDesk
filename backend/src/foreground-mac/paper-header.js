// Runs under macOS JavaScript for Automation. Input is only the recorder's existing JPEG.
// Return transient top-of-window OCR to the parent process; no image or OCR is written to disk.
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('Vision');
function run() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const frame = $.NSBitmapImageRep.imageRepWithData(data);
  if (!frame || !frame.pixelsHigh || !frame.pixelsWide) return '[]';
  const width = Number(frame.pixelsWide), height = Number(frame.pixelsHigh);
  const request = $.VNRecognizeTextRequest.alloc.init;
  request.recognitionLevel = 0;
  request.usesLanguageCorrection = false;
  request.recognitionLanguages = ['en-US', 'zh-Hans', 'zh-Hant'];
  const fraction = Math.min(1, 260 / height);
  request.regionOfInterest = $.CGRectMake(0, 1 - fraction, 1, fraction);
  const handler = $.VNImageRequestHandler.alloc.initWithCGImageOptions(frame.CGImage, $({}));
  const error = Ref();
  if (!handler.performRequestsError($.NSArray.arrayWithObject(request), error)) throw Error('OCR unavailable');
  const results = request.results, boxes = [];
  for (let i = 0; i < results.count; ++i) {
    const hit = results.objectAtIndex(i), candidate = hit.topCandidates(1).firstObject;
    if (!candidate || Number(candidate.confidence) < 0.35) continue;
    const b = hit.boundingBox;
    boxes.push({text:ObjC.unwrap(candidate.string), x:b.origin.x * width,
      y:(1 - b.origin.y - b.size.height / 2) * height * fraction, height:b.size.height * height * fraction});
  }
  return JSON.stringify(boxes);
}
