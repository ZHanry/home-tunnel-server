#!/usr/bin/env node
// Offline operation: reads a public keyset and old key, creates two new files only.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const thumbprint = key => createHash("sha256").update(JSON.stringify({crv:key.crv,kty:key.kty,x:key.x,y:key.y})).digest("base64url");
export async function rotateKey({ keyFile, keysetFile, outputKey, outputKeyset, now = Date.now() }) {
  const paths = [keyFile,keysetFile,outputKey,outputKeyset].map(path=>resolve(path));
  if(new Set(paths).size!==4)throw new Error("All input/output paths must be distinct");
  const current=JSON.parse(await readFile(keysetFile,"utf8"));
  const previous=createPrivateKey(await readFile(keyFile));
  if(previous.asymmetricKeyType!=="ec" || previous.asymmetricKeyDetails?.namedCurve!=="prime256v1")throw new Error("Old key must be P-256");
  const oldPublic=createPublicKey(previous).export({format:"jwk"}),kid=thumbprint(oldPublic);
  const active=current.keys?.find(key=>key.kid===current.active_kid);
  if(!current.server_instance_id || !Number.isSafeInteger(current.keyset_version) || current.keyset_version<1 || current.active_kid!==kid || !active || thumbprint(active.public_jwk)!==kid || Date.parse(active.not_before)>now || Date.parse(active.not_after)<=now || !Array.isArray(current.rotation_proofs) || current.rotation_proofs.length>=32)throw new Error("Current keyset does not match a valid old key; chain limit is 32 rotations");
  const fresh=generateKeyPairSync("ec",{namedCurve:"P-256"}),jwk=fresh.publicKey.export({format:"jwk"}),newKid=thumbprint(jwk);
  const issued=new Date(now).toISOString();
  const keyset={keyset_version:current.keyset_version+1,active_kid:newKid,keys:[
    {...active,not_after:new Date(Math.min(Date.parse(active.not_after),now+3600000)).toISOString()},
    {kid:newKid,alg:"ES256",public_jwk:jwk,not_before:issued,not_after:new Date(now+365*86400000).toISOString()}
  ]};
  const payload={server_instance_id:current.server_instance_id,from_version:current.keyset_version,to_version:keyset.keyset_version,from_kid:kid,issued_at:issued,keyset};
  const header=Buffer.from(JSON.stringify({alg:"ES256",typ:"ht-rd-keyset+jwt",kid})).toString("base64url"),body=Buffer.from(JSON.stringify(payload)).toString("base64url");
  const proof=`${header}.${body}.${sign("sha256",Buffer.from(`${header}.${body}`),{key:previous,dsaEncoding:"ieee-p1363"}).toString("base64url")}`;
  const manifest={server_instance_id:current.server_instance_id,...keyset,rotation_proofs:[...current.rotation_proofs,proof]};
  // Exclusive creates prevent replacing any deployed or existing key. Partial output is safe to inspect/remove manually.
  await writeFile(outputKey,fresh.privateKey.export({type:"pkcs8",format:"pem"}),{flag:"wx",mode:0o600});
  await writeFile(outputKeyset,`${JSON.stringify(manifest,null,2)}\n`,{flag:"wx",mode:0o644});
  return manifest;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [keyFile,keysetFile,outputKey,outputKeyset,...extra]=process.argv.slice(2);
  if(!outputKeyset || extra.length)throw new Error("Usage: node rotate-rd-key.mjs OLD_KEY CURRENT_PUBLIC_KEYSET NEW_KEY NEW_PUBLIC_KEYSET");
  await rotateKey({keyFile,keysetFile,outputKey,outputKeyset});
  process.stdout.write("Created new private key and signed public keyset; deploy both together and retain the encrypted old backup.\n");
}
