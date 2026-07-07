import SimplePeer from "simple-peer";
import { useEffect, useRef, useState } from "react";
import { Socket } from "socket.io-client";
import { boostOpusAudio } from "../lib/sdp";

interface UseWebRTCOptions {
  socket: Socket;
  selfId: string | null;
  peerIds: string[];
  localStream: MediaStream | null;
  enabled: boolean;
}

// Mesh topology: every participant connects directly to every other one.
// To avoid both sides racing to be the initiator, whichever socket id sorts
// first (lexicographically) initiates the offer; the other side waits for it.
export function useWebRTC({ socket, selfId, peerIds, localStream, enabled }: UseWebRTCOptions) {
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const peersRef = useRef<Map<string, SimplePeer.Instance>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(localStream);
  localStreamRef.current = localStream;
  // Peers created before our own camera/mic finished initializing: an
  // incoming offer can arrive while getUserMedia's permission prompt is
  // still up, so the peer gets built with no local stream -- and nothing
  // would ever attach it afterwards, leaving the connection silently
  // one-way (we see/hear them; they never see/hear us). Tracked here so the
  // effect below can add the stream retroactively the moment it's ready.
  const streamlessPeersRef = useRef<Set<string>>(new Set());

  function destroyPeer(peerId: string) {
    const peer = peersRef.current.get(peerId);
    if (peer) {
      peer.destroy();
      peersRef.current.delete(peerId);
    }
    streamlessPeersRef.current.delete(peerId);
    setRemoteStreams((prev) => {
      if (!(peerId in prev)) return prev;
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  }

  function createPeer(peerId: string, initiator: boolean): SimplePeer.Instance {
    const stream = localStreamRef.current;
    if (!stream) streamlessPeersRef.current.add(peerId);
    const peer = new SimplePeer({
      initiator,
      trickle: true,
      stream: stream ?? undefined,
      sdpTransform: boostOpusAudio,
    });

    peer.on("signal", (data) => {
      socket.emit("signal", { to: peerId, data });
    });
    peer.on("stream", (remoteStream) => {
      setRemoteStreams((prev) => ({ ...prev, [peerId]: remoteStream }));
    });
    peer.on("close", () => destroyPeer(peerId));
    peer.on("error", (err) => {
      console.error(`Error en la conexión WebRTC con ${peerId}:`, err);
      destroyPeer(peerId);
    });

    peersRef.current.set(peerId, peer);
    return peer;
  }

  useEffect(() => {
    function handleSignal({ from, data }: { from: string; data: SimplePeer.SignalData }) {
      let peer = peersRef.current.get(from);
      if (!peer) {
        peer = createPeer(from, false);
      }
      try {
        peer.signal(data);
      } catch {
        destroyPeer(from);
      }
    }

    socket.on("signal", handleSignal);
    return () => {
      socket.off("signal", handleSignal);
    };
  }, [socket, localStream]);

  // Retroactively attach the local stream to any peer that was created
  // before it existed (see streamlessPeersRef above) -- simple-peer
  // renegotiates automatically when a stream is added mid-connection.
  useEffect(() => {
    if (!localStream) return;
    for (const peerId of Array.from(streamlessPeersRef.current)) {
      const peer = peersRef.current.get(peerId);
      streamlessPeersRef.current.delete(peerId);
      if (!peer) continue;
      try {
        peer.addStream(localStream);
      } catch {
        // Peer mid-negotiation/closed; if it matters the mesh effect below
        // will rebuild the connection.
      }
    }
  }, [localStream]);

  useEffect(() => {
    if (!enabled || !selfId) return;

    const desired = new Set(peerIds.filter((id) => id !== selfId));

    for (const peerId of desired) {
      if (!peersRef.current.has(peerId) && selfId < peerId) {
        createPeer(peerId, true);
      }
    }

    for (const existingId of Array.from(peersRef.current.keys())) {
      if (!desired.has(existingId)) {
        destroyPeer(existingId);
      }
    }
  }, [enabled, selfId, peerIds.join(","), localStream]);

  useEffect(() => {
    const peers = peersRef.current;
    return () => {
      peers.forEach((peer) => peer.destroy());
      peers.clear();
    };
  }, []);

  // Swaps the outgoing video track (e.g. camera <-> screen share) on every
  // already-connected peer, without a full renegotiation/reconnect. New
  // peers that connect afterwards pick up the current track automatically
  // since they're constructed from `localStream`, whose tracks the caller
  // is expected to have already swapped in place (same MediaStream object).
  function replaceVideoTrack(oldTrack: MediaStreamTrack | null, newTrack: MediaStreamTrack) {
    const stream = localStreamRef.current;
    if (!stream) return;
    peersRef.current.forEach((peer) => {
      try {
        if (oldTrack) {
          peer.replaceTrack(oldTrack, newTrack, stream);
        } else {
          peer.addTrack(newTrack, stream);
        }
      } catch {
        // Peer may be mid-negotiation or already closed; nothing to recover.
      }
    });
  }

  function removeVideoTrack(track: MediaStreamTrack) {
    const stream = localStreamRef.current;
    if (!stream) return;
    peersRef.current.forEach((peer) => {
      try {
        peer.removeTrack(track, stream);
      } catch {
        // ignore
      }
    });
  }

  // Same as replaceVideoTrack -- simple-peer's replaceTrack works for any
  // track kind, so device switches (mic OR camera) reuse it.
  return { remoteStreams, replaceVideoTrack, removeVideoTrack, replaceTrack: replaceVideoTrack };
}
