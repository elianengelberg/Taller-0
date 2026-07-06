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

  function destroyPeer(peerId: string) {
    const peer = peersRef.current.get(peerId);
    if (peer) {
      peer.destroy();
      peersRef.current.delete(peerId);
    }
    setRemoteStreams((prev) => {
      if (!(peerId in prev)) return prev;
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  }

  function createPeer(peerId: string, initiator: boolean): SimplePeer.Instance {
    const peer = new SimplePeer({
      initiator,
      trickle: true,
      stream: localStream ?? undefined,
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
