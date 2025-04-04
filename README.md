![Random Rants Logo](https://randomrants.glitch.me/random-rants-logo-text.png)

# Random Rants - File Storage Server

This is where Random Rants stores user media and other user content.

## Upload API (V1) [Disabled by default]

A file is stored on the server using a POST request.

Send the request to ``/uploadfile`` with the body being something like ``
{
  "data": "(base64 here)",
  "contentType": "text/plain"
}
``

***It can overload the server if the request is large enough.***

Response will be like: ``
{
  "id": "123",
  "key": "abc123"
}
``

Only use this to upload small files now.

**NOTICE: This version of the API is deprecated and no longer enabled on the server by default.**

## Upload API (V2)

This is made with the FormData API in mind, also to allow loading larger files.
One file can be sent per request.

Send the request to ``/uploadfilev2`` to upload, make sure its POST as well.

Responds same as API V1.

## Upload Limitations

One file can be uploaded at once, if multiple then it would be paused until the other file is uploaded.
This is to prevent possible interference with other files.
Not an intentional limitation.

## Download API

Once the server responds with the right response JSON, you can request like ``/file/123/abc123``.

``123`` being the id, and ``abc123`` being the key. Note this is not a real file, a real file request would have the key be random numbers and letters and the ID whatever the files number in the storage is.

## Security warning

No encryption is used on the files or metadata for them. This means that if someone has access to the Firebase storage bucket, they can see any file you send.
Now all though I avoid trying to look into files sent, and even if I do, I will still avoid talking about them publically.
As long as you avoid sending the Firebase storage bucket, you can not view the files directly off this server unless a key in the url is specified.

## Notice:

You must have a Google account to run this server, it needs to be able to contain a Firebase storage server.
