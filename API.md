# R2-WebDAV API Documentation

## Authentication

### WebDAV Authentication
All WebDAV operations require HTTP Basic Authentication.

```
Authorization: Basic base64(username:password)
```

### Admin API Authentication
Admin API endpoints require Bearer token authentication.

```
Authorization: Bearer YOUR_ADMIN_TOKEN
```

---

## Admin API

Base path: `/admin/`

### Admin UI

```
GET /admin/
```

Returns the admin management interface (HTML page).

**Response:** `200 OK` with HTML content

---

### List Users

```
GET /admin/users
```

Returns all registered users.

**Headers:**
- `Authorization: Bearer YOUR_ADMIN_TOKEN`

**Response:**
```json
[
  {
    "username": "alice",
    "isAdmin": true,
    "createdAt": "2024-01-15T10:30:00.000Z"
  },
  {
    "username": "bob",
    "isAdmin": false,
    "createdAt": "2024-01-16T14:20:00.000Z"
  }
]
```

**Status Codes:**
- `200 OK` - Success
- `401 Unauthorized` - Missing or invalid token
- `403 Forbidden` - Invalid admin token

---

### Create User

```
POST /admin/users
```

Creates a new user account.

**Headers:**
- `Authorization: Bearer YOUR_ADMIN_TOKEN`
- `Content-Type: application/json`

**Request Body:**
```json
{
  "username": "alice",
  "password": "secret123",
  "isAdmin": false
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| username | string | Yes | 1-64 chars, alphanumeric, dot, underscore, hyphen |
| password | string | Yes | User password |
| isAdmin | boolean | No | Grant admin privileges (default: false) |

**Response:**
```json
{
  "success": true,
  "username": "alice"
}
```

**Status Codes:**
- `201 Created` - User created
- `400 Bad Request` - Invalid username format or missing fields
- `401 Unauthorized` - Missing token
- `403 Forbidden` - Invalid admin token

---

### Delete User

```
DELETE /admin/users/{username}
```

Deletes a user account. Does not delete user's files in R2.

**Headers:**
- `Authorization: Bearer YOUR_ADMIN_TOKEN`

**Response:**
```json
{
  "success": true
}
```

**Status Codes:**
- `200 OK` - User deleted
- `400 Bad Request` - Missing username
- `401 Unauthorized` - Missing token
- `403 Forbidden` - Invalid admin token

---

## User Registration

### Self-Register

```
POST /register
```

Allows users to register themselves.

**Headers:**
- `Content-Type: application/json`

**Request Body:**
```json
{
  "username": "newuser",
  "password": "mypassword",
  "token": "REGISTER_TOKEN"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| username | string | Yes | 1-64 chars, alphanumeric, dot, underscore, hyphen |
| password | string | Yes | Minimum 6 characters |
| token | string | Conditional | Required if `REGISTER_TOKEN` is configured |

**Response:**
```json
{
  "success": true,
  "username": "newuser"
}
```

**Status Codes:**
- `201 Created` - Registration successful
- `400 Bad Request` - Invalid input or single-user mode
- `401 Unauthorized` - Registration token required but not provided
- `403 Forbidden` - Invalid registration token
- `405 Method Not Allowed` - Only POST allowed
- `409 Conflict` - Username already taken

---

## WebDAV API

All WebDAV endpoints require Basic Authentication. In multi-user mode, each user's files are isolated under their `username/` prefix in R2.

### Supported Methods

| Method | Description |
|--------|-------------|
| OPTIONS | Get supported methods and DAV compliance |
| GET | Download file or list directory |
| HEAD | Get file metadata without body |
| PUT | Upload file |
| DELETE | Delete file or directory |
| MKCOL | Create directory |
| COPY | Copy file or directory |
| MOVE | Move/rename file or directory |
| PROPFIND | Get properties of file or directory |
| PROPPATCH | Update properties |

### DAV Compliance

```
DAV: 1, 3
```

---

### OPTIONS

```
OPTIONS /path/to/resource
```

Returns supported methods and DAV compliance level.

**Response Headers:**
- `Allow: OPTIONS, PROPFIND, PROPPATCH, MKCOL, GET, HEAD, PUT, DELETE, COPY, MOVE`
- `DAV: 1, 3`

**Status Codes:**
- `204 No Content`

---

### GET

```
GET /path/to/file
GET /path/to/directory/
```

Download a file or list directory contents.

**For files:** Returns file content with appropriate Content-Type.

**For directories (URL ends with `/`):** Returns HTML listing of directory contents.

**Headers (optional):**
- `Range: bytes=0-1023` - Partial content request

**Status Codes:**
- `200 OK` - Success
- `206 Partial Content` - Range request fulfilled
- `401 Unauthorized` - Authentication required
- `404 Not Found` - Resource not found
- `412 Precondition Failed` - Conditional request failed

---

### PUT

```
PUT /path/to/file
```

Upload or overwrite a file.

**Headers:**
- `Content-Type: application/octet-stream` (or appropriate type)

**Body:** File content

**Status Codes:**
- `201 Created` - File created
- `401 Unauthorized` - Authentication required
- `405 Method Not Allowed` - Cannot PUT to directory path
- `409 Conflict` - Parent directory does not exist

---

### DELETE

```
DELETE /path/to/resource
```

Delete a file or directory (including all contents).

**Status Codes:**
- `204 No Content` - Successfully deleted
- `401 Unauthorized` - Authentication required
- `404 Not Found` - Resource not found

---

### MKCOL

```
MKCOL /path/to/new-directory
```

Create a new directory.

**Status Codes:**
- `201 Created` - Directory created
- `401 Unauthorized` - Authentication required
- `405 Method Not Allowed` - Resource already exists
- `409 Conflict` - Parent directory does not exist

---

### COPY

```
COPY /source/path
```

Copy a file or directory.

**Headers:**
- `Destination: https://host/destination/path` (required)
- `Overwrite: T|F` (optional, default: T)
- `Depth: 0|infinity` (optional, default: infinity)

**Status Codes:**
- `201 Created` - Copied to new location
- `204 No Content` - Copied, overwrote existing
- `400 Bad Request` - Missing Destination header
- `401 Unauthorized` - Authentication required
- `404 Not Found` - Source not found
- `409 Conflict` - Destination parent does not exist
- `412 Precondition Failed` - Overwrite=F and destination exists

---

### MOVE

```
MOVE /source/path
```

Move or rename a file or directory.

**Headers:**
- `Destination: https://host/destination/path` (required)
- `Overwrite: T|F` (optional, default: F)
- `Depth: 0|infinity` (optional, default: infinity)

**Status Codes:**
- `201 Created` - Moved to new location
- `204 No Content` - Moved, overwrote existing
- `400 Bad Request` - Missing Destination or same source/destination
- `401 Unauthorized` - Authentication required
- `404 Not Found` - Source not found
- `409 Conflict` - Destination parent does not exist
- `412 Precondition Failed` - Overwrite=F and destination exists

---

### PROPFIND

```
PROPFIND /path/to/resource
```

Get properties of a file or directory.

**Headers:**
- `Depth: 0|1|infinity` (optional, default: infinity)

**Request Body (optional):**
```xml
<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:">
  <prop>
    <resourcetype/>
    <getcontentlength/>
    <getlastmodified/>
  </prop>
</propfind>
```

**Response:** `207 Multi-Status` with XML body

```xml
<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
  <response>
    <href>/path/to/file</href>
    <propstat>
      <prop>
        <creationdate>Sat, 15 Jan 2024 10:30:00 GMT</creationdate>
        <getcontentlength>1024</getcontentlength>
        <getcontenttype>text/plain</getcontenttype>
        <getetag>"abc123"</getetag>
        <getlastmodified>Sat, 15 Jan 2024 10:30:00 GMT</getlastmodified>
        <resourcetype/>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>
```

**Properties:**
| Property | Description |
|----------|-------------|
| creationdate | Upload timestamp |
| displayname | Content-Disposition header value |
| getcontentlanguage | Content-Language header value |
| getcontentlength | File size in bytes |
| getcontenttype | MIME type |
| getetag | Entity tag |
| getlastmodified | Last modified timestamp |
| resourcetype | `<collection/>` for directories, empty for files |

**Status Codes:**
- `207 Multi-Status` - Success
- `401 Unauthorized` - Authentication required
- `403 Forbidden` - Invalid Depth header
- `404 Not Found` - Resource not found

---

### PROPPATCH

```
PROPPATCH /path/to/resource
```

Update custom properties on a resource.

**Request Body:**
```xml
<?xml version="1.0" encoding="utf-8"?>
<propertyupdate xmlns="DAV:">
  <set>
    <prop>
      <customProperty>value</customProperty>
    </prop>
  </set>
  <remove>
    <prop>
      <anotherProperty/>
    </prop>
  </remove>
</propertyupdate>
```

**Response:** `207 Multi-Status` with XML body

**Status Codes:**
- `207 Multi-Status` - Success
- `401 Unauthorized` - Authentication required
- `404 Not Found` - Resource not found

---

## CORS

All responses include CORS headers:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: OPTIONS, PROPFIND, PROPPATCH, MKCOL, GET, HEAD, PUT, DELETE, COPY, MOVE
Access-Control-Allow-Headers: authorization, content-type, depth, overwrite, destination, range
Access-Control-Expose-Headers: content-type, content-length, dav, etag, last-modified, location, date, content-range
Access-Control-Max-Age: 86400
```

---

## Error Responses

### JSON Errors (Admin/Registration API)

```json
{
  "error": "Error message description"
}
```

### Text Errors (WebDAV)

Plain text error messages:
- `Unauthorized`
- `Not Found`
- `Method Not Allowed`
- `Conflict`
- `Precondition Failed`
- `Bad Request`
