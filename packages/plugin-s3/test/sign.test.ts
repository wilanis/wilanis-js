/**
 * The signature against the worked example AWS publishes for Signature Version 4 with S3 ("GET Object", in
 * "Authenticating Requests: Using the Authorization Header"): the same request, keys and instant must give the
 * same signature, byte for byte, or no store speaking the API would accept a request this plugin sends.
 */
import { describe, expect, it } from 'vitest';
import { encode, sha256, signed } from '../src/sign.js';

const KEYS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const AT = new Date('2013-05-24T00:00:00Z');

describe('Signature Version 4', () => {
  it("signs AWS's GET Object example as AWS does", () => {
    const headers = signed(
      {
        method: 'GET',
        url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
        headers: { range: 'bytes=0-9' },
        payloadHash: sha256(''),
      },
      KEYS,
      'us-east-1',
      AT,
    );
    expect(headers['x-amz-date']).toBe('20130524T000000Z');
    expect(headers['x-amz-content-sha256']).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('encodes every byte but the unreserved ones', () => {
    expect(encode("a b/c!'()*~._-")).toBe('a%20b%2Fc%21%27%28%29%2A~._-');
  });
});
