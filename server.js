var gvbbaseStorage = require("./storage.js");
var storage = new gvbbaseStorage(process.env.sbBucket,process.env.sbURL,process.env.sbAPIKey);

var Busboy = require("busboy");

var port = process.env.serverPort || 8593;
var legacyUploadEnabled = false; //Change to true to enable the original uploadfile method.

var path = require("path");
var fs = require("fs");
var URL = require("url");

var ws = require("ws");
//Sizes are in bytes.
var maxFileCount = 16; //How many files are stored until the count drops back to zero.
var maxFileCachingSize = 0; //No more caching.
var maxFileUploadSize = 5e+7; //100mb max
var fileCache = {};
var statusWebsockets = {};

function ab2str(buf) {
  return String.fromCharCode.apply(null, new Uint16Array(buf));
}

function str2ab(str) {
  var buf = new ArrayBuffer(str.length * 2); // 2 bytes for each char
  var bufView = new Uint16Array(buf);
  for (var i = 0, strLen = str.length; i < strLen; i++) {
    bufView[i] = str.charCodeAt(i);
  }
  return buf;
}

function createStatusWebsocketServer(id) {
  if (id) {
    var wss = new ws.WebSocketServer({ noServer: true });
    statusWebsockets[id] = wss;
    wss.uploadStatus = "";
    wss.on("connection", (client) => {
      client.send(
        JSON.stringify({
          type: "updateStatus",
          status: wss.uploadStatus,
        })
      );
    });
    return wss;
  }
}

function setStatusOnWebsocketServer(id, status) {
  if (statusWebsockets[id]) {
    var wss = statusWebsockets[id];
    wss.uploadStatus = status;
    wss.clients.forEach((client) => {
      client.send(
        JSON.stringify({
          type: "updateStatus",
          status: wss.uploadStatus,
        })
      );
    });
  }
}

function closeStatusWebsocket(id) {
  var wss = statusWebsockets[id];
  wss.uploadStatus = null;
  wss.clients.forEach((client) => {
    client.send(
      JSON.stringify({
        type: "finished",
      })
    );
    client.close();
  });
  wss.close();
  statusWebsockets[id] = undefined;
}

function fixCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
}

function createKeyString(length) {
  var keys = "ABCDEFGHIJKLKMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890";
  var key = "";
  var i = 0;
  while (i < length) {
    key += keys[Math.round(Math.random() * (keys.length - 1))];
    i += 1;
  }
  return key;
}

var uploadsPending = 0;

function waitForUploadPendingFinish() {
  return new Promise((accept) => {
    function wait() {
      if (uploadsPending < 1) {
        accept();
      } else {
        setTimeout(wait, 1);
      }
    }
    wait();
  });
}

var http = require("http");
function _base64ToArrayBuffer(base64) {
  var binary_string = window.atob(base64);
  var len = binary_string.length;
  var bytes = new Uint8Array(len);
  for (var i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes.buffer;
}
function arrayBufferToJSON(ab) {
  return JSON.stringify(Array.from(new Uint8Array(ab)));
}

function setNoCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
}
function runStaticStuff(req, res, forceStatus) {
  var url = URL.parse(req.url);
  var pathname = url.pathname;

  setNoCorsHeaders(res);

  var file = path.join("./static/", pathname);
  if (pathname == "/") {
    file = "static/index.html";
  }
  if (file.split(".").length < 2) {
    file += ".html";
  }

  if (!fs.existsSync(file)) {
    file = "errors/404.html";
    res.statusCode = 404;
  }

  if (typeof forceStatus !== "undefined") {
    file = "errors/" + forceStatus + ".html";
    res.statusCode = forceStatus;
  }

  fs.createReadStream(file).pipe(res);
}

function getHeaderValue(headers, headerName) {
  for (var key of Object.keys(headers)) {
    if (key.toLowerCase() == headerName.toLowerCase()) {
      return headers[key];
    }
  }
  return null;
}
//Use this to find a file from its name.
var findmode = false;
var filequery = "";
(async function () {
  if (findmode) {
    //Change to true to use filename.
    var filecountbuffer = await storage.downloadFile("filecount.txt");
    var count = Number(filecountbuffer.toString());
    var i = 1000;
    console.log(`Searching files ${i} through ${count}`);
    while (i < count) {
      try {
        try {
            var fileText = (
              await storage.downloadFile("file" + i + ".json")
            ).toString();
            console.log(`Looking in file ${i}.`);
            var fileJSON = JSON.parse(fileText);
            if (fileJSON.originalFilename) {
              if (fileJSON.contentType.startsWith("application/")) {
              console.log(fileJSON);
              fs.writeFileSync("filefound"+i+".txt",JSON.stringify(fileJSON));
            }
            if (
              fileJSON.originalFilename
                .toLowerCase()
                .indexOf(filequery.toLowerCase()) > -1
            ) {
              console.log(`Found file ${i} in files.`);
            }
            }
          } catch (e) {
            console.warn(`File number ${i} ran into error during find. ${e}`);
          }
      } catch (e) {
        console.warn(`File number ${i} ran into error during find. ${e}`);
      }
      i += 1;
    }
  }
})();

(async function () {
  try {
    var filecountbuffer = await storage.downloadFile("filecount.txt");
    var count = Number(filecountbuffer.toString());
  } catch (e) {
    await storage.uploadFile("filecount.txt", "1", "text/plain");
  }
})();
var server = http.createServer(async (req, res) => {
  console.log(
    `[${req.headers["x-forwarded-for"] || req.connection.remoteAddress}]: ${
      req.method
    } ${req.url} ${req.headers["user-agent"]}`
  );
  fixCors(res);
  var url = decodeURIComponent(req.url);
  var urlsplit = url.split("/");
  if (urlsplit[1] === "uploadfilev2" && req.method === "POST") {
    var busboy = Busboy({ headers: req.headers });
    var fileBuffer = null;
    var fileInfo = {};

    var totalBytes = 0;
    var bytesReceived = 0;
    var ended = false;

    // Set totalBytes when the Content-Length is known
    if (req.headers["content-length"]) {
      totalBytes = parseInt(req.headers["content-length"], 10);
    }

    if (totalBytes > maxFileUploadSize) {
      res.statusCode = 413;
      res.end("File is too big.");
      return;
    }

    if (urlsplit[2]) {
      if (statusWebsockets[urlsplit[2]]) {
        res.end(
          JSON.stringify({
            error: true,
            message: "Status websocket must not exist, or not be open.",
          })
        );
        return;
      }
      createStatusWebsocketServer(urlsplit[2]);
    }

    busboy.on("file", (uname, file, uinfo) => {
      var chunks = [];
      fileInfo = {
        filename: uname,
        mimetype: uinfo.mimeType,
      };

      file.on("data", (chunk) => {
        chunks.push(chunk);
        bytesReceived += chunk.length;
        if (bytesReceived > maxFileUploadSize) {
          res.statusCode = 413;
          res.end("File was bigger than expected, request ended.");
          ended = true;
          return;
        }
        if (totalBytes > 0) {
          var progress = ((bytesReceived / totalBytes) * 100).toFixed(2);

          setStatusOnWebsocketServer(
            urlsplit[2],
            `Receiving file... (${progress}%)`
          );
        } else {
          setStatusOnWebsocketServer(
            urlsplit[2],
            `Receiving file... (${bytesReceived} bytes)`
          );
        }
      });

      file.on("end", () => {
        if (ended) {
          closeStatusWebsocket(urlsplit[2]);
          return;
        }
        setStatusOnWebsocketServer(urlsplit[2], "File received, processing...");
        fileBuffer = Buffer.concat(chunks);
      });
    });

    busboy.on("finish", async () => {
      if (ended) {
        closeStatusWebsocket(urlsplit[2]);
        return;
      }
      setStatusOnWebsocketServer(
        urlsplit[2],
        "Waiting for other files to finish uploading..."
      );
      await waitForUploadPendingFinish();
      uploadsPending += 1;
      setStatusOnWebsocketServer(urlsplit[2], "Storing file...");
      try {
        setStatusOnWebsocketServer(urlsplit[2], "Getting the file count...");
        var filecountbuffer = await storage.downloadFile("filecount.txt");
        var count = Number(filecountbuffer.toString());
        var uploadID = count + 1;
        var key = createKeyString(20);
        setStatusOnWebsocketServer(urlsplit[2], "Saving file metadata...");
        await storage.uploadFile(
          `file${uploadID}.json`,
          JSON.stringify(
            {
              contentType: fileInfo.mimetype || "application/octet-stream",
              key: key,
              originalFilename: fileInfo.filename,
            },
            null,
            "\t"
          ),
          "application/json"
        );

        setStatusOnWebsocketServer(urlsplit[2], "Storing file contents...");
        await storage.uploadFile(
          `file${uploadID}-contents.file`,
          fileBuffer,
          fileInfo.mimetype || "application/octet-stream"
        );

        setStatusOnWebsocketServer(urlsplit[2], "Updating the file count...");
        await storage.uploadFile(
          "filecount.txt",
          uploadID.toString(),
          "text/plain"
        );

        if (fileBuffer.length < maxFileCachingSize) {
          fileCache[uploadID] = fileBuffer;
        }

        setStatusOnWebsocketServer(urlsplit[2], "Upload complete!");
        closeStatusWebsocket(urlsplit[2]);
        var meta = { id: uploadID.toString(), key: key };
        uploadsPending -= 1;
        res.end(JSON.stringify(meta));
      } catch (err) {
        console.error("Error uploading file:", err);
        setStatusOnWebsocketServer(urlsplit[2], "Upload failed.");
        closeStatusWebsocket(urlsplit[2]);
        res.statusCode = 500;
        uploadsPending -= 1;
        res.end("File upload failed");
      }
    });

    req.pipe(busboy);
    return;
  }

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept"
    );
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.statusCode = 204; // No Content
    return res.end();
  }

  if (legacyUploadEnabled) {
    if (urlsplit[1] == "uploadfile" && req.method == "POST") {
      if (urlsplit[2]) {
        createStatusWebsocketServer(urlsplit[2]);
      }
      var bytes = 0;
      setStatusOnWebsocketServer(urlsplit[2], `Receiving data...`);
      var body = "";
      req.on("data", (d) => {
        bytes += d.length;
        body += d;
        if (req.headers["content-length"]) {
          var length = Number(req.headers["content-length"]);
          var percent = Math.round((bytes / length) * 100);
          setStatusOnWebsocketServer(
            urlsplit[2],
            `Receiving data... (${percent}%)`
          );
        } else {
          setStatusOnWebsocketServer(
            urlsplit[2],
            `Receiving data... (${bytes} bytes)`
          );
        }
      });
      req.on("end", async () => {
        try {
          setStatusOnWebsocketServer(urlsplit[2], "Parsing data...");
          var fileinfo = JSON.parse(body);
          setStatusOnWebsocketServer(
            urlsplit[2],
            "Waiting for other files to finish uploading..."
          );
          await waitForUploadPendingFinish();
          uploadsPending += 1;
          setStatusOnWebsocketServer(urlsplit[2], "Getting file count...");
          try {
            var filecountbuffer = await storage.downloadFile("filecount.txt");
            var count = Number(filecountbuffer.toString());
            count += 1;
            if (count > maxFileCount) {
              count = 0;
            }
            var uploadID = count;
          } catch (e) {
            var count = 1;
            var uploadID = 1;
          }
          var key = createKeyString(20);
          setStatusOnWebsocketServer(
            urlsplit[2],
            "Writing file information..."
          );
          await storage.uploadFile(
            "file" + uploadID + ".json",
            JSON.stringify(
              {
                contentType: fileinfo.contentType,
                key: key,
              },
              null,
              "\t"
            ),
            "application/json"
          );
          setStatusOnWebsocketServer(urlsplit[2], "Uploading...");
          var buffer = Buffer.from(fileinfo.data, "base64");
          await storage.uploadFile(
            "file" + uploadID + "-contents.file",
            buffer,
            fileinfo.contentType
          );
          if (buffer.length < maxFileCachingSize) {
            setStatusOnWebsocketServer(urlsplit[2], "Uploading to cache...");
            fileCache[uploadID] = buffer;
          }
          setStatusOnWebsocketServer(urlsplit[2], "Adding to file count...");
          await storage.uploadFile(
            "filecount.txt",
            uploadID.toString(),
            "text/plain"
          );
          uploadsPending -= 1;
          setStatusOnWebsocketServer(urlsplit[2], "Done!");
          closeStatusWebsocket(urlsplit[2]);
          res.end(JSON.stringify({ id: uploadID.toString(), key: key }));
        } catch (e) {
          uploadsPending -= 1;
          closeStatusWebsocket(urlsplit[2]);
          console.log(`Failed to upload file: ${e}`);
          res.statusCode = 404;
          res.end(e.toString());
        }
      });
      return;
    }
  }

  if (urlsplit[1] == "file" && req.method == "GET") {
    try {
      var fileid = urlsplit[2];
      var filekey = urlsplit[3];
      var rangeHeader = getHeaderValue(req.headers, "range"); //Used on browser media players, to only get the part of the video/audio it needs at the time.
      var data = JSON.parse(
        await storage.downloadFile("file" + fileid + ".json") //This is a small file containing the key for the upload, as well as the content type and any other important information.
      );

      if (data.key == filekey) {
        //Must provide the "content-type" header otherwise the browser will not know what type of file we are sending to it.
        res.setHeader("content-type", data.contentType);
        if (fileCache[fileid] && !rangeHeader) {
          res.end(fileCache[fileid]);
        } else {
          var customheaders = {};
          if (rangeHeader) {
            customheaders.range = rangeHeader; //Allow range header to let the browser media player be able to seek through the file quickly.
          }

          var obj = await storage.downloadFileResponseProxy(
            "file" + fileid + "-contents.file",
            customheaders, //Rather than manually downloading all the file then providing the part it needs, we can just save loading time by providing the "range" header to the file download request.
            res, //Faster way of getting response, allows for bigger files to start downloading soon as possible. Also allows server to load the file all while also proxying the request response at the same time.
            [
              //Apply these headers from the download response to the server's response.
              //Content-Type is not used because its provided by the files metadata.
              "content-range",
              "accept-ranges",
              "content-range",
              "content-length", //Add content-length header to provide how much content needs to be downloaded.
            ]
          );
          var buffer = obj.buffer;
          if (!rangeHeader) {
            //Can't be cached with a partial response, this is only used for full responses.
            if (buffer.length < maxFileCachingSize) {
              fileCache[fileid] = buffer; //We can cache the file's contents if its smaller than the max caching size.
            }
          }
        }
      } else {
        res.statusCode = 403;
        res.end(
          "The file key is not vaild, or no key was provided. The key must be added after the file number. Example: /file/123/key123"
        );
      }
      return;
    } catch (e) {
      res.statusCode = 404; //Assume its not a existing file, respond with 404 error.
      res.end(e.toString());
      return;
    }
  }

  if (urlsplit[1] == "status" && req.method == "GET") {
    var filecountbuffer = await storage.downloadFile("filecount.txt");
    var count = Number(filecountbuffer.toString());
    res.end("ok");
    return;
  }
  if (urlsplit[1] == "filecount" && req.method == "GET") {
    try {
      var filecountbuffer = await storage.downloadFile("filecount.txt");
      res.end(filecountbuffer.toString());
      return;
    } catch (e) {
      res.statusCode = 404;
      res.end(e.toString());
      return;
    }
  }
  /*if (urlsplit[1] == "deletefile" && req.method == "GET") {
    try {
      var fileid = urlsplit.slice(2, urlsplit.length).join("/");
      var fileinfo = {
        contentType: "text/plain",
        arraybuffer: "File removed by owner.",
      };
      var uploadID = fileid;
      await storage.uploadFile(
        "file" + uploadID + ".json",
        JSON.stringify(
          {
            contentType: fileinfo.contentType,
          },
          null,
          "\t"
        ),
        "application/json"
      );

      await storage.uploadFile(
        "file" + uploadID + "-contents.file",
        Buffer.from(fileinfo.arraybuffer),
        fileinfo.contentType
      );

      await storage.uploadFile(
        "filecount.txt",
        uploadID.toString(),
        "text/plain"
      );
      res.end(uploadID.toString());
      return;
    } catch (e) {
      res.statusCode = 404;
      res.end(e.toString());
      return;
    }
  }*/
  runStaticStuff(req, res);
});

server.on("upgrade", function upgrade(request, socket, head) {
  var url = decodeURIComponent(request.url);
  var urlsplit = url.split("/");
  setTimeout(() => {
    if (statusWebsockets[urlsplit[1]]) {
      var wss = statusWebsockets[urlsplit[1]];
      wss.handleUpgrade(request, socket, head, function done(ws) {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
      request.destroy();
    }
  });
});
server.listen(port);
console.log(`HTTP server listening on ${port}`);
process.on("uncaughtException", function (err) {
  console.log("Fatal Error! ", err);
  server.close();
  process.exit();
});
console.clear();
