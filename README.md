![Random Rants Logo](https://randomrants.glitch.me/random-rants-logo-text.png)

# MIGRATION NOTICE

Random rants filestore has migrated to supabase because of the free limitations on google's firebase storage.
This is so there is no cutoff on random rant's filestore's uploading during the transition from googles appspot storage, but all files have been kept on the original bucket from the server because of this migration.
You won't be able to find your old files any more and there is a file count limit as well. (you can only upload 18 files before the server resets its counter and all new files uploaded will overwrite the old ones and require new keys)
New enviroment variables required are on the bottom of this readme.

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

## Preparing Supabase enviroment variables

Create a Supabase project and provide the following enviroment vairales:

* sbBucket: Your Supabase storage bucket
* sbAPIKey: Your Supabase secret key or api key (I recommend secret key)
* sbURL: Your Supabase project url (Needs to be like `https://projectid.supabase.co`)
