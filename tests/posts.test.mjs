import "dotenv/config";
import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { Module, BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AuthGuard } from "../dist/auth/auth.guard.js";
import { AuthService } from "../dist/auth/auth.service.js";
import { createAccessToken } from "../dist/utils/token.js";
import { PostsController } from "../dist/posts/posts.controller.js";
import { PostsService } from "../dist/posts/posts.service.js";
import { PostStorageService } from "../dist/posts/post-storage.service.js";
import { buildFeedRandomizationPlan, encodeFeedRandomizationCursor, encodeFeedRandomizationSession, parseFeedRandomizationCursor, parseFeedRandomizationSession, parseId, parseMutation, parsePostRandomize, parsePostType, validateMedia } from "../dist/posts/posts.validation.js";
import { PrismaService } from "../dist/prisma/prisma.service.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
const file = { originalname: "pixel.png", mimetype: "image/png", size: png.length, buffer: png };
const input = content => parseMutation({ content, privacy: "public", keepMediaIds: "[]" });

test("rejects invalid IDs, injected media IDs and malformed mutation bodies", () => {
    for (const value of ["0", "-1", "1.1", "18446744073709551616", "1 OR 1=1", null]) assert.throws(() => parseId(value), BadRequestException);
    assert.equal(parseId(1), 1n, "safe integer IDs are accepted by the existing parser");
    for (const body of [{content:"x",privacy:"unknown"},{content:"x",keepMediaIds:'["1","1"]'},{content:"x",keepMediaIds:"{}"},{content:"x",keepMediaIds:'["-1"]'},{content:"x".repeat(5001)}, { content: {} }]) assert.throws(() => parseMutation(body), BadRequestException);
    assert.deepEqual(parseMutation({content:"  hello  ",privacy:"private",keepMediaIds:'["12"]'}),{content:"hello",privacy:"private",keepMediaIds:[12n]});
    assert.equal(parseMutation({content:"clip",postType:"video",keepMediaIds:"[]"}).postType,"video");
    assert.throws(() => parseMutation({content:"x",postType:"livestream"}),BadRequestException);
    assert.equal(parsePostType("video"),"video");
    assert.throws(() => parsePostType("other"),BadRequestException);
});
test("validates binary signatures, empty files and per-file/combined upload limits", () => {
    validateMedia([file]);
    assert.throws(() => validateMedia([{...file,mimetype:"video/mp4"}]), BadRequestException);
    assert.throws(() => validateMedia([{...file,mimetype:"image/svg+xml"}]), BadRequestException);
    assert.throws(() => validateMedia([{...file,size:0,buffer:Buffer.alloc(0)}]), BadRequestException);
    assert.throws(() => validateMedia(Array(6).fill(file)), BadRequestException);
    assert.throws(() => validateMedia([{...file,size:26*1024*1024}]), BadRequestException);
    assert.throws(() => validateMedia(Array(3).fill({...file,size:20*1024*1024})), BadRequestException);
});

test("a video-kind post must include a video attachment", async () => {
    const storage = { upload: async () => { throw new Error("should not upload"); }, remove: async () => {} };
    const service = new PostsService({}, storage);
    await assert.rejects(service.create(1n, parseMutation({content:"clip",postType:"video",keepMediaIds:"[]"}), [file]), BadRequestException);
});

test("validates deterministic randomized-feed sessions and cursors", () => {
    const seed = "0123456789abcdef0123456789abcdef";
    const session = { version: 1, seed, snapshotId: "123" };
    const cursor = { version: 1, seed, segment: 3, lastId: "42" };
    assert.deepEqual(parseFeedRandomizationSession(encodeFeedRandomizationSession(session)), session);
    assert.deepEqual(parseFeedRandomizationCursor(encodeFeedRandomizationCursor(cursor)), cursor);
    assert.deepEqual(buildFeedRandomizationPlan(seed), buildFeedRandomizationPlan(seed), "same seed has same segment order and direction");
    assert.equal(new Set(buildFeedRandomizationPlan(seed).segments).size, 8);
    assert.throws(() => parseFeedRandomizationSession("not-a-session"));
    assert.throws(() => parseFeedRandomizationCursor(Buffer.from(JSON.stringify({ version: 1, seed, segment: 8, lastId: "42" })).toString("base64url")));
    assert.equal(parsePostRandomize("true"), true);
    assert.equal(parsePostRandomize(undefined), false);
    assert.throws(() => parsePostRandomize("maybe"));
});
test("checks ownership before uploads and cleans files after partial upload or database failure", async () => {
    let uploads = 0; const removed = [];
    const storage = { upload: async () => { uploads++; return {key:"test-key",name:"pixel.png",size:png.length,type:"image/png"}; }, remove: async keys => removed.push(...keys) };
    const foreign = new PostsService({posts:{findFirst:async()=>({user_id:2n})}},storage);
    await assert.rejects(foreign.update(1n,1n,input("x"),[file]),ForbiddenException);
    await assert.rejects(foreign.remove(1n,1n),ForbiddenException);
    assert.equal(uploads,0);
    const failure = new PostsService({$transaction:async()=>{throw new Error("database unavailable");}},storage);
    await assert.rejects(failure.create(1n,input("x"),[file]),/database unavailable/);
    assert.deepEqual(removed,["test-key"]);
    let count=0; const cleaned=[];
    const partial = new PostsService({}, {upload:async()=>{if(++count===2)throw new Error("storage unavailable");return {key:"first-key"};},remove:async keys=>cleaned.push(...keys)});
    await assert.rejects(partial.create(1n,input("x"),[file,file]),/storage unavailable/);
    assert.deepEqual(cleaned,["first-key"]);
});

test("HTTP guard, multipart parsing and body validation work together", async () => {
    const calls=[];
    const listCalls=[];
    const service={create:async(userId,body,files)=>{validateMedia(files);calls.push({userId,body,files});return {success:true,post:{id:"1"}};},list:async(userId,dto)=>{listCalls.push({userId,dto});return {success:true,posts:[],nextCursor:null};},update:async()=>({success:true}),remove:async()=>({success:true})};
    const session={getSessionCurrentUser:async(sessionId,userId)=>sessionId==="posts-test"&&userId===1n?{id:"1"}:null};
    class TestModule {}
    Module({controllers:[PostsController],providers:[AuthGuard,{provide:AuthService,useValue:session},{provide:PostsService,useValue:service}]})(TestModule);
    const app=await NestFactory.create(TestModule,{logger:false});await app.listen(0,"127.0.0.1");
    const base=await app.getUrl();
    const token=createAccessToken(1n,"posts-test");
    try {
        assert.equal((await fetch(base+"/api/posts")).status,401);
        assert.equal((await fetch(base+"/api/posts",{headers:{Authorization:"Bearer "+createAccessToken(1n,"expired-session")}})).status,401);
        const form=new FormData();form.set("content"," Hello ");form.set("privacy","public");form.set("keepMediaIds","[]");form.set("postType","post");form.append("media",new Blob([png],{type:"image/png"}),"pixel.png");
        const result=await fetch(base+"/api/posts",{method:"POST",headers:{Authorization:"Bearer "+token},body:form});
        assert.equal(result.status,201);assert.equal(calls[0].userId,1n);assert.equal(calls[0].body.content,"Hello");assert.equal(calls[0].body.postType,"post");assert.equal(calls[0].files[0].buffer.length,png.length);
        assert.equal((await fetch(base+"/api/posts/not-an-id",{method:"DELETE",headers:{Authorization:"Bearer "+token}})).status,400);
        assert.equal((await fetch(base+"/api/posts?authorId=invalid",{headers:{Authorization:"Bearer "+token}})).status,400);
        assert.equal((await fetch(base+"/api/posts?randomize=true&search=hello",{headers:{Authorization:"Bearer "+token}})).status,400,"relevance searches keep their existing ordering");
        const randomized=await fetch(base+"/api/posts?randomize=true",{headers:{Authorization:"Bearer "+token}});
        assert.equal(randomized.status,200);assert.equal(listCalls.at(-1).userId,1n);assert.equal(listCalls.at(-1).dto.randomize,true);
        assert.equal((await fetch(base+"/api/posts?postType=video",{headers:{Authorization:"Bearer "+token}})).status,200);
        assert.equal(listCalls.at(-1).dto.postType,"video");
        assert.equal((await fetch(base+"/api/posts?postType=invalid",{headers:{Authorization:"Bearer "+token}})).status,400);
        const seed="0123456789abcdef0123456789abcdef";
        const feedSession=encodeFeedRandomizationSession({version:1,seed,snapshotId:"99"});
        const feedCursor=encodeFeedRandomizationCursor({version:1,seed,segment:2,lastId:"42"});
        assert.equal((await fetch(base+`/api/posts?randomize=true&feedSession=${feedSession}&cursor=${feedCursor}`,{headers:{Authorization:"Bearer "+token}})).status,200);
        assert.equal(listCalls.at(-1).dto.randomCursor.lastId,"42");
        const otherSeed="fedcba9876543210fedcba9876543210";
        const mismatchedCursor=encodeFeedRandomizationCursor({version:1,seed:otherSeed,segment:2,lastId:"42"});
        assert.equal((await fetch(base+`/api/posts?randomize=true&feedSession=${feedSession}&cursor=${mismatchedCursor}`,{headers:{Authorization:"Bearer "+token}})).status,400,"cursor cannot be replayed with another feed session");
        const invalid=new FormData();invalid.set("content","x");invalid.append("media",new Blob(["not png"],{type:"image/png"}),"fake.png");
        assert.equal((await fetch(base+"/api/posts",{method:"POST",headers:{Authorization:"Bearer "+token},body:invalid})).status,400);
        const maximum=new FormData();maximum.set("content","x");maximum.set("privacy","public");maximum.set("keepMediaIds","[]");for(let i=0;i<5;i++)maximum.append("media",new Blob([png],{type:"image/png"}),"pixel.png");
        assert.equal((await fetch(base+"/api/posts",{method:"POST",headers:{Authorization:"Bearer "+token},body:maximum})).status,201);
        const tooMany=new FormData();tooMany.set("content","x");for(let i=0;i<6;i++)tooMany.append("media",new Blob([png],{type:"image/png"}),"pixel.png");
        assert.equal((await fetch(base+"/api/posts",{method:"POST",headers:{Authorization:"Bearer "+token},body:tooMany})).status,400);
    } finally { await app.close(); }
});

test("real database: CRUD, privacy, search, pagination and attachment ownership; all fixtures roll back", {skip:process.env.POSTS_DB_TESTS!=="1"}, async()=>{
    const prisma=new PrismaService(); const marker="posts-test-"+crypto.randomUUID(); const rollback=new Error("ROLLBACK_TEST_FIXTURES");
    const removed=[];let sequence=0;
    const storage={upload:async(_,f)=>({key:"posts/1/"+(++sequence)+".png",type:f.mimetype,name:f.originalname,size:f.size}),url:async key=>"https://media.example.invalid/"+key,remove:async keys=>removed.push(...keys)};
    try {
        await assert.rejects(prisma.$transaction(async tx=>{
            const user1=await tx.users.create({data:{email:marker+"-1@example.invalid",password_hash:"test-only",first_name:"Actor",last_name:"Test"}});
            const user2=await tx.users.create({data:{email:marker+"-2@example.invalid",password_hash:"test-only"}});
            const user3=await tx.users.create({data:{email:marker+"-3@example.invalid",password_hash:"test-only"}});
            await tx.friendships.create({data:{requester_id:user1.id,addressee_id:user2.id,status:"accepted"}});
            const adapter=new Proxy(tx,{get(target,key){return key==="$transaction" ? callback=>callback(tx) : target[key];}});
            const service=new PostsService(adapter,storage);
            const created=await service.create(user1.id,input(marker),[file]);
            const id=BigInt(created.post.id);const attachment=created.post.media[0];
            assert.equal(created.post.author.name,"Test Actor");assert.equal(created.post.canEdit,true);assert.equal(created.post.media.length,1);
            const stranger=await service.list(user3.id,undefined,marker);assert.equal(stranger.posts.length,1);assert.equal(stranger.posts[0].canEdit,false);
            await assert.rejects(service.update(user2.id,id,input("attack"),[]),ForbiddenException);
            await assert.rejects(service.remove(user2.id,id),ForbiddenException);
            const edited=await service.update(user1.id,id,{...input(marker+" edited"),privacy:"friends",keepMediaIds:[BigInt(attachment.id)]},[]);
            assert.equal(edited.post.media[0].id,attachment.id);
            assert.equal((await service.list(user2.id,undefined,marker)).posts.length,1,"friend can read friends-only post");
            assert.equal((await service.list(user3.id,undefined,marker)).posts.length,0,"stranger cannot read friends-only post");
            await service.update(user1.id,id,{...input(marker),privacy:"private",keepMediaIds:[BigInt(attachment.id)]},[]);
            assert.equal((await service.list(user2.id,undefined,marker)).posts.length,0,"friend cannot read private post");
            assert.equal((await service.list(user1.id,undefined,marker)).posts.length,1,"owner can read private post");
            const another = await service.create(user2.id,input(marker+" other author"),[]);
            const ownProfile = await service.list(user1.id,undefined,marker,user1.id);
            assert.equal(ownProfile.author.id,user1.id.toString());assert.equal(ownProfile.total,1);
            assert.ok(ownProfile.posts.every(post=>post.author.id===user1.id.toString()),"profile excludes another author");
            const otherProfile = await service.list(user1.id,undefined,marker,user2.id);
            assert.equal(otherProfile.posts.length,1);assert.equal(otherProfile.posts[0].id,another.post.id);
            const privateProfile = await service.list(user3.id,undefined,marker,user1.id);
            assert.equal(privateProfile.posts.length,0);assert.equal(privateProfile.total,0,"profile filter must not expose private counts");
            const emptyProfile = await service.list(user1.id,undefined,marker,user3.id);
            assert.equal(emptyProfile.posts.length,0);assert.equal(emptyProfile.author.id,user3.id.toString());
            await assert.rejects(service.list(user1.id,undefined,marker,18446744073709551615n),NotFoundException);
            await service.remove(user2.id,BigInt(another.post.id));
            await service.update(user1.id,id,input(marker+" replaced"),[file]);
            assert.ok(removed.includes("posts/1/1.png"),"replaced object cleaned");
            await tx.posts.createMany({data:Array.from({length:22},(_,i)=>({user_id:user1.id,content:marker+" page "+i,privacy:"public"}))});
            const page1=await service.list(user1.id,undefined,marker);assert.equal(page1.posts.length,20);assert.ok(page1.nextCursor);
            const page2=await service.list(user1.id,BigInt(page1.nextCursor),marker);assert.equal(page2.posts.length,3);assert.equal(page2.nextCursor,null);assert.ok(!page2.posts.some(post=>page1.posts.some(other=>other.id===post.id)));
            const profilePage1=await service.list(user1.id,undefined,marker,user1.id);
            const profilePage2=await service.list(user1.id,BigInt(profilePage1.nextCursor),marker,user1.id);
            assert.equal(profilePage1.total,23);assert.equal(profilePage2.total,23);assert.equal(profilePage2.posts.length,3);

            const videoFixture=await tx.posts.findFirst({where:{user_id:user1.id,content:marker+" page 0"},select:{id:true}});
            await tx.attachments.create({data:{owner_type:"post",owner_id:videoFixture.id,file_url:"posts/1/test-video.mp4",file_type:"video/mp4",file_name:"test-video.mp4",file_size:12n}});
            const randomizedFirst=await service.list(user1.id,{authorId:user1.id,randomize:true});
            assert.equal(randomizedFirst.posts.length,20);assert.ok(randomizedFirst.feedSession);assert.ok(randomizedFirst.nextCursor);
            const session=parseFeedRandomizationSession(randomizedFirst.feedSession);
            const baseRows=await tx.posts.findMany({where:{user_id:user1.id,deleted_at:null,approval_status:"PUBLISHED"},select:{id:true}});
            const baseIds=baseRows.map(row=>row.id);
            const late=await tx.posts.create({data:{user_id:user1.id,content:marker+" newly created",privacy:"private"}});
            const repeatedFirst=await service.list(user1.id,{authorId:user1.id,randomize:true,feedSession:session});
            assert.deepEqual(repeatedFirst.posts.map(post=>post.id),randomizedFirst.posts.map(post=>post.id),"same session keeps its first page stable after a new post is created");
            async function collectRandomized(first, feedSession) {
                const collected=[...first.posts];let current=first;
                while(current.nextCursor){
                    current=await service.list(user1.id,{authorId:user1.id,randomize:true,feedSession,randomCursor:parseFeedRandomizationCursor(current.nextCursor)});
                    collected.push(...current.posts);
                }
                return collected;
            }
            const randomizedAll=await collectRandomized(randomizedFirst,session);
            assert.equal(randomizedAll.length,baseIds.length,"all posts in the session snapshot are returned");
            assert.equal(new Set(randomizedAll.map(post=>post.id)).size,randomizedAll.length,"pagination has no duplicate posts");
            assert.deepEqual(new Set(randomizedAll.map(post=>post.id)),new Set(baseIds.map(String)),"pagination skips no eligible posts");
            assert.ok(!randomizedAll.some(post=>post.id===late.id.toString()),"posts created after the session snapshot are reserved for a fresh feed");
            const mediaTypes=new Set(randomizedAll.flatMap(post=>post.media.map(media=>media.type)));
            assert.ok(mediaTypes.has("image/png"));assert.ok(mediaTypes.has("video/mp4"));
            const mediaOnly=await service.list(user1.id,{authorId:user1.id,randomize:true,mediaOnly:true});
            assert.ok(mediaOnly.posts.length>0);assert.ok(mediaOnly.posts.every(post=>post.media.length>0),"media-only filter is preserved");

            const snapshot=BigInt(session.snapshotId);
            const sequenceForSeed=seed=>{
                const plan=buildFeedRandomizationPlan(seed);
                return plan.segments.flatMap((bucket,index)=>{
                    const lower=(snapshot*BigInt(bucket))/8n+1n;const upper=(snapshot*BigInt(bucket+1))/8n;
                    return baseIds.filter(postId=>postId>=lower&&postId<=upper).sort((a,b)=>plan.directions[index]==="asc"?(a<b?-1:a>b?1:0):(a>b?-1:a<b?1:0)).map(String);
                }).join(",");
            };
            const seedA="00000000000000000000000000000001";const expectedA=sequenceForSeed(seedA);
            let seedB;for(let candidate=2;candidate<1000;candidate++){const seed=candidate.toString(16).padStart(32,"0");if(sequenceForSeed(seed)!==expectedA){seedB=seed;break;}}
            assert.ok(seedB,"fixtures span enough buckets for a second deterministic order");
            const seededA={version:1,seed:seedA,snapshotId:session.snapshotId};const seededB={version:1,seed:seedB,snapshotId:session.snapshotId};
            const orderA=await collectRandomized(await service.list(user1.id,{authorId:user1.id,randomize:true,feedSession:seededA}),seededA);
            const orderB=await collectRandomized(await service.list(user1.id,{authorId:user1.id,randomize:true,feedSession:seededB}),seededB);
            assert.deepEqual(orderA.map(post=>post.id).join(","),expectedA,"database pages follow the deterministic seeded segment order");
            assert.notDeepEqual(orderA.map(post=>post.id),orderB.map(post=>post.id),"a different seed changes ordering");
            const refreshed=await service.list(user1.id,{authorId:user1.id,randomize:true});
            assert.notEqual(refreshed.feedSession,randomizedFirst.feedSession,"a fresh refresh receives a new session seed");
            const refreshedAll=await collectRandomized(refreshed,parseFeedRandomizationSession(refreshed.feedSession));
            assert.ok(refreshedAll.some(post=>post.id===late.id.toString()),"a new post appears in a new feed session");
            await service.remove(user1.id,id);
            assert.ok((await tx.posts.findUnique({where:{id}})).deleted_at);
            assert.equal(await tx.attachments.count({where:{owner_type:"post",owner_id:id}}),0);
            await assert.rejects(service.remove(user1.id,id),NotFoundException);
            throw rollback;
        },{timeout:120000}),error=>error===rollback);
        assert.equal(await prisma.users.count({where:{email:{startsWith:marker}}}),0,"test accounts rolled back");
    }finally{await prisma.$disconnect();}
});

test("real MinIO: private upload, signed GET and Range, cleanup only the test object", {skip:process.env.POSTS_MINIO_TESTS!=="1"}, async()=>{
    const storage=new PostStorageService();let key;
    try {
        const uploaded=await storage.upload(1n,file);key=uploaded.key;
        const url=await storage.url(key,"image/png");
        const response=await fetch(url);assert.equal(response.status,200);assert.equal(response.headers.get("content-type"),"image/png");assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
        const privateUrl=new URL(url);privateUrl.search="";assert.equal((await fetch(privateUrl)).status,403);
        const range=await fetch(url,{headers:{Range:"bytes=0-7"}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,8);
        await storage.remove([key]);assert.equal((await fetch(url)).status,404);
    }finally{if(key)await storage.remove([key]);storage.onModuleDestroy?.();}
});

test("real database rejects media from another post and rolls back the mutation", {skip:process.env.POSTS_DB_TESTS!=="1"}, async()=>{
    const prisma=new PrismaService();const marker="posts-ownership-"+crypto.randomUUID();
    try{
        await assert.rejects(prisma.$transaction(async tx=>{
            const user=await tx.users.create({data:{email:marker+"@example.invalid",password_hash:"test-only"}});
            const first=await tx.posts.create({data:{user_id:user.id,content:"original"}});
            const second=await tx.posts.create({data:{user_id:user.id,content:"another post"}});
            const media=await tx.attachments.create({data:{owner_type:"post",owner_id:second.id,file_url:"posts/1/foreign.png",file_type:"image/png"}});
            const adapter=new Proxy(tx,{get(target,key){return key==="$transaction" ? callback=>callback(tx) : target[key];}});
            const service=new PostsService(adapter,{remove:async()=>{},upload:async()=>{throw Error("Unexpected upload");}});
            await service.update(user.id,first.id,{content:"changed",privacy:"public",keepMediaIds:[media.id]},[]);
        },{timeout:30000}),BadRequestException);
        assert.equal(await prisma.users.count({where:{email:marker+"@example.invalid"}}),0);
    }finally{await prisma.$disconnect();}
});
