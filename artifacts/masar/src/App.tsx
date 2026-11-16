import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { useGetPresence, getGetPresenceQueryKey, useHealthCheck, getHealthCheckQueryKey } from '@workspace/api-client-react';
import type { PresenceUser } from '@workspace/api-client-react';
import * as maplibregl from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { io } from 'socket.io-client';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  Activity, ArrowDownLeft, Check, ChevronDown, CircleHelp, Compass, Copy, Crosshair, LocateFixed,
  MapPin, MessageCircle, Navigation, Radio, Send, Smartphone, Users, Wifi, WifiOff, X, Mountain,
  Satellite, Map as MapIcon, Eye, EyeOff, Trash2, RefreshCw, Sun, Star
} from 'lucide-react';

const queryClient = new QueryClient();
maplibregl.setWorkerUrl(maplibreWorkerUrl);
const AVATAR_COLORS = ['#d5e7dd', '#f2ddc6', '#dce4ee', '#ead9de', '#e5e4ca'];
const AVATAR_OPTIONS = [
  { id: 'compass', label: 'بوصلة' },
  { id: 'mountain', label: 'جبل' },
  { id: 'sun', label: 'شمس' },
  { id: 'star', label: 'نجمة' },
];
type Profile = { id: string; name: string; avatar: string; color: string };
type Pin = { id: string; label: string; latitude: number; longitude: number; createdAt: string };
type ChatMessage = { id: string; fromId: string; toId: string; text: string; createdAt: string; exactCoordinates?: { latitude: number; longitude: number } };
type GeoPoint = { latitude: number; longitude: number; altitude?: number | null; speed?: number | null };
type MapHandle = { map: any; library: any };

const DB_NAME = 'masar-local';
function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('records')) db.createObjectStore('records');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function readLocal<T>(key: string): Promise<T | undefined> {
  try {
    const db = await openStore();
    return await new Promise((resolve, reject) => {
      const req = db.transaction('records', 'readonly').objectStore('records').get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  } catch { return undefined; }
}
async function saveLocal(key: string, value: unknown): Promise<void> {
  try {
    const db = await openStore();
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction('records', 'readwrite').objectStore('records').put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch { /* Local features remain usable when browser storage is restricted. */ }
}
function distanceKm(a: Pick<GeoPoint, 'latitude' | 'longitude'>, b: Pick<GeoPoint, 'latitude' | 'longitude'>) {
  const rad = (n: number) => n * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude), dLon = rad(b.longitude - a.longitude);
  const v = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(v), Math.sqrt(1 - v));
}
function arabicDistance(km: number) { return km < 1 ? `${Math.round(km * 1000)} م` : `${km.toFixed(1)} كم`; }
function initials(name: string) { return name.trim().split(/\s+/).slice(0, 2).map(x => x[0]).join('') || 'م'; }
function AvatarIcon({ name, size = 17 }: { name: string; size?: number }) {
  if (name === 'mountain') return <Mountain size={size} />;
  if (name === 'sun') return <Sun size={size} />;
  if (name === 'star') return <Star size={size} />;
  return <Compass size={size} />;
}

function Home() {
  const presenceQuery = useGetPresence({ query: { queryKey: getGetPresenceQueryKey(), refetchInterval: 18000, retry: 1 } });
  const healthQuery = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 45000, retry: 1 } });
  const mapElement = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapHandle | null>(null);
  const appliedLayer = useRef<'standard' | 'satellite' | 'terrain' | null>(null);
  const centeredOnFix = useRef(false);
  const socketRef = useRef<any>(null);
  const geoWatch = useRef<number | null>(null);
  const simulationTimer = useRef<number | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileName, setProfileName] = useState('');
  const [profileColor, setProfileColor] = useState<string>(AVATAR_COLORS[0]);
  const [profileAvatar, setProfileAvatar] = useState('compass');
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [location, setLocation] = useState<GeoPoint | null>(null);
  const [permissionError, setPermissionError] = useState('');
  const [tracking, setTracking] = useState(false);
  const [ghost, setGhost] = useState(false);
  const [connected, setConnected] = useState(false);
  const [layer, setLayer] = useState<'standard' | 'satellite' | 'terrain'>('standard');
  const [selected, setSelected] = useState<PresenceUser | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [pins, setPins] = useState<Pin[]>([]);
  const [placingPin, setPlacingPin] = useState(false);
  const placingPinRef = useRef(false);
  const [notice, setNotice] = useState('');
  const [mobilePeopleOpen, setMobilePeopleOpen] = useState(false);
  const people = (presenceQuery.data ?? []).filter(person => person.id !== profile?.id);
  placingPinRef.current = placingPin;
  const online = navigator.onLine && healthQuery.data?.status !== 'offline';
  const selectedMessages = useMemo(() => selected && profile ? messages.filter(m =>
    (m.fromId === profile.id && m.toId === selected.id) || (m.fromId === selected.id && m.toId === profile.id)
  ).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : [], [messages, profile, selected]);

  const say = useCallback((text: string) => {
    setNotice(text); window.setTimeout(() => setNotice(''), 2600);
  }, []);
  useEffect(() => {
    let alive = true;
    Promise.all([readLocal<Profile>('profile'), readLocal<Pin[]>('pins'), readLocal<ChatMessage[]>('messages')]).then(([p, savedPins, savedMessages]) => {
      if (!alive) return;
      if (p) { setProfile(p); setProfileName(p.name); setProfileColor(p.color); setProfileAvatar(p.avatar); }
      setPins(savedPins ?? []); setMessages(savedMessages ?? []); setProfileLoaded(true);
    });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js').catch(() => undefined);
    return () => { alive = false; };
  }, []);
  useEffect(() => { if (profile) void saveLocal('profile', profile); }, [profile]);
  useEffect(() => { void saveLocal('pins', pins); }, [pins]);
  useEffect(() => { void saveLocal('messages', messages); }, [messages]);

  useEffect(() => {
    const onOnline = () => { queryClient.invalidateQueries({ queryKey: getGetPresenceQueryKey() }); queryClient.invalidateQueries({ queryKey: getHealthCheckQueryKey() }); };
    const onOffline = () => setConnected(false);
    window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const boot = () => {
      try {
        if (cancelled || !mapElement.current || mapRef.current) return;
        const lib = maplibregl;
        const map = new lib.Map({
          container: mapElement.current, center: location ? [location.longitude, location.latitude] : [46.6753, 24.7136], zoom: 12.2,
          style: {
            version: 8, sources: { base: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap contributors' } },
            layers: [{ id: 'base', type: 'raster', source: 'base', paint: { 'raster-saturation': -0.24, 'raster-contrast': -0.03 } }]
          }
        });
        mapRef.current = { map, library: lib };
        appliedLayer.current = 'standard';
        map.on('click', (event: any) => {
          if (!placingPinRef.current) return;
          const label = window.prompt('اكتب اسم هذا المكان');
          if (!label?.trim()) { setPlacingPin(false); return; }
          setPins(prev => [...prev, { id: crypto.randomUUID(), label: label.trim(), latitude: event.lngLat.lat, longitude: event.lngLat.lng, createdAt: new Date().toISOString() }]);
          setPlacingPin(false); say('تم حفظ الموقع في أماكنك');
        });
      } catch { if (!cancelled) say('الخريطة غير متاحة الآن؛ تحقق من اتصالك'); }
    };
    boot();
    return () => { cancelled = true; mapRef.current?.map.remove(); mapRef.current = null; };
  }, [say]);

  useEffect(() => {
    if (location && !centeredOnFix.current) {
      mapRef.current?.map.flyTo({ center: [location.longitude, location.latitude], zoom: 14.5, duration: 850 });
      centeredOnFix.current = true;
    }
  }, [location]);

  useEffect(() => {
    const handle = mapRef.current;
    if (!handle) return;
    const { map, library } = handle;
    const markers: any[] = [];
    people.forEach(user => {
      const node = document.createElement('button');
      node.type = 'button'; node.className = 'avatar person-marker'; node.setAttribute('aria-label', `محادثة مع ${user.name}`);
      node.style.width = '42px'; node.style.height = '42px'; node.style.background = AVATAR_COLORS[(user.name.length + user.id.length) % AVATAR_COLORS.length];
      node.textContent = initials(user.name); node.onclick = () => choosePerson(user);
      const marker = new library.Marker({ element: node, anchor: 'bottom' }).setLngLat([user.longitude, user.latitude]).addTo(map);
      markers.push(marker);
    });
    pins.forEach(pin => {
      const node = document.createElement('div'); node.className = 'pin-marker'; node.style.cssText = 'width:28px;height:28px;border-radius:50% 50% 50% 4px;background:#d78b3e;color:#fff;display:grid;place-items:center;transform:rotate(-45deg);border:2px solid #fff;box-shadow:0 3px 10px #253d3855';
      node.innerHTML = '<span style="transform:rotate(45deg);display:grid"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg></span>';
      const marker = new library.Marker({ element: node, anchor: 'bottom' }).setLngLat([pin.longitude, pin.latitude]).addTo(map);
      markers.push(marker);
    });
    if (location) {
      const node = document.createElement('div'); node.className = 'self-pulse'; node.style.cssText = 'width:22px;height:22px;border:5px solid #fff;border-radius:50%;background:#1c7666;box-shadow:0 0 0 8px #1c766644,0 4px 12px #153f36aa';
      const marker = new library.Marker({ element: node }).setLngLat([location.longitude, location.latitude]).addTo(map); markers.push(marker);
    }
    return () => markers.forEach(marker => marker.remove());
  }, [people, pins, location, selected, profile]);

  useEffect(() => {
    const m = mapRef.current?.map;
    if (!m || appliedLayer.current === layer) return;
    appliedLayer.current = layer;
    const sources = {
      standard: { tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], attribution: '© OpenStreetMap contributors' },
      satellite: { tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], attribution: 'Tiles © Esri' },
      terrain: { tiles: ['https://tile.opentopomap.org/{z}/{x}/{y}.png'], attribution: '© OpenTopoMap' }
    };
    const s = sources[layer];
    m.setStyle({ version: 8, sources: { base: { type: 'raster', tiles: s.tiles, tileSize: 256, attribution: s.attribution } }, layers: [{ id: 'base', type: 'raster', source: 'base', paint: { 'raster-saturation': layer === 'standard' ? -.24 : 0 } }] });
  }, [layer]);

  useEffect(() => {
    if (!profile || !online) { setConnected(false); return; }
    let gone = false;
    const start = async () => {
      try {
        if (gone) return;
        const socket = io({ path: '/socket.io', transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: Infinity });
        socketRef.current = socket;
        socket.on('connect', () => { setConnected(true); socket.emit('masar:join', { id: profile.id, name: profile.name, avatar: profile.avatar, ghost }); });
        socket.on('disconnect', () => setConnected(false));
        socket.on('connect_error', () => setConnected(false));
        socket.on('masar:message', (incoming: ChatMessage) => setMessages(prev => prev.some(m => m.id === incoming.id) ? prev : [...prev, incoming]));
        socket.on('masar:error', (error: { message?: string }) => say(error.message || 'تعذر إتمام العملية'));
        socket.on('masar:presence', () => queryClient.invalidateQueries({ queryKey: getGetPresenceQueryKey() }));
      } catch { setConnected(false); }
    };
    void start();
    return () => { gone = true; socketRef.current?.disconnect(); socketRef.current = null; };
  }, [profile?.id, online, say]);

  useEffect(() => {
    if (connected && profile && socketRef.current) socketRef.current.emit('masar:ghost', { ghost });
  }, [ghost, connected, profile]);
  useEffect(() => {
    if (tracking && location && connected && !ghost && socketRef.current) {
      socketRef.current.emit('masar:location', { ...location, updatedAt: new Date().toISOString() });
    }
  }, [tracking, location, connected, ghost]);
  useEffect(() => () => {
    if (geoWatch.current !== null) navigator.geolocation?.clearWatch(geoWatch.current);
    if (simulationTimer.current !== null) window.clearInterval(simulationTimer.current);
  }, []);

  const choosePerson = (person: PresenceUser) => {
    setSelected(person); setMobilePeopleOpen(false);
    mapRef.current?.map.flyTo({ center: [person.longitude, person.latitude], zoom: 15.5, duration: 950 });
  };
  const saveProfile = () => {
    const name = profileName.trim();
    if (!name) return;
    const created = { id: crypto.randomUUID(), name, avatar: profileAvatar, color: profileColor };
    setProfile(created);
    startTracking();
  };
  const startTracking = () => {
    setPermissionError('');
    if (!navigator.geolocation) { setPermissionError('خدمة تحديد الموقع غير مدعومة في هذا المتصفح'); return; }
    if (geoWatch.current !== null) navigator.geolocation.clearWatch(geoWatch.current);
    if (simulationTimer.current !== null) { window.clearInterval(simulationTimer.current); simulationTimer.current = null; }
    setTracking(true);
    geoWatch.current = navigator.geolocation.watchPosition(position => {
      setLocation({ latitude: position.coords.latitude, longitude: position.coords.longitude, altitude: position.coords.altitude, speed: position.coords.speed });
    }, error => {
      setTracking(false);
      setPermissionError(error.code === 1 ? 'لم يتم السماح بالوصول إلى الموقع. غيّر الإذن من إعدادات المتصفح.' : 'تعذر تحديد موقعك. تحقق من إعدادات الموقع وحاول مجدداً.');
    }, { enableHighAccuracy: true, maximumAge: 4000, timeout: 15000 });
  };
  const stopTracking = () => {
    if (geoWatch.current !== null) navigator.geolocation.clearWatch(geoWatch.current);
    geoWatch.current = null; setTracking(false);
  };
  const recenter = () => {
    if (!location) { startTracking(); say('بانتظار إشارة الموقع'); return; }
    mapRef.current?.map.flyTo({ center: [location.longitude, location.latitude], zoom: 15.5, duration: 900 });
  };
  const toggleSimulation = () => {
    if (simulationTimer.current !== null) {
      window.clearInterval(simulationTimer.current); simulationTimer.current = null; setTracking(false); say('توقفت محاكاة الحركة'); return;
    }
    if (geoWatch.current !== null) navigator.geolocation?.clearWatch(geoWatch.current);
    geoWatch.current = null;
    setTracking(true);
    const initial = location ?? { latitude: 24.7136, longitude: 46.6753, altitude: 612, speed: 1.2 };
    setLocation(initial); say('بدأت محاكاة الحركة');
    simulationTimer.current = window.setInterval(() => setLocation(prev => {
      const point = prev ?? initial;
      return { latitude: point.latitude + 0.00012, longitude: point.longitude + 0.00018, altitude: (point.altitude ?? 610) + 0.4, speed: 1.4 };
    }), 2200);
  };
  const sendMessage = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !selected || !profile) return;
    if (!online || !connected || !socketRef.current) { say('لا يمكن إرسال الرسائل دون اتصال'); return; }
    const message: ChatMessage = { id: crypto.randomUUID(), fromId: profile.id, toId: selected.id, text, createdAt: new Date().toISOString() };
    socketRef.current.emit('masar:message', message, (result: { ok: boolean; error?: string }) => {
      if (result?.ok) return;
      setMessages(prev => prev.filter(item => item.id !== message.id));
      setDraft(text);
      say(result?.error || 'تعذر إرسال الرسالة');
    });
    setMessages(prev => [...prev, message]); setDraft('');
  };
  const shareCoordinates = async () => {
    if (!location) { say('فعّل تحديد الموقع أولاً'); return; }
    const coordinates = `${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`;
    try { await navigator.clipboard.writeText(coordinates); say('نُسخت الإحداثيات'); } catch { say(coordinates); }
  };
  const shareToChat = () => {
    if (!selected || !profile || !location) { say('اختر شخصاً وفعّل تحديد الموقع'); return; }
    if (!online || !connected || !socketRef.current) { say('لا يمكن مشاركة الموقع دون اتصال'); return; }
    const coords = { latitude: location.latitude, longitude: location.longitude };
    const msg: ChatMessage = { id: crypto.randomUUID(), fromId: profile.id, toId: selected.id, text: 'مشاركة إحداثياتي الدقيقة', createdAt: new Date().toISOString(), exactCoordinates: coords };
    socketRef.current.emit('masar:message', msg, (result: { ok: boolean; error?: string }) => {
      if (result?.ok) return;
      setMessages(prev => prev.filter(item => item.id !== msg.id));
      say(result?.error || 'تعذرت مشاركة الموقع');
    });
    setMessages(prev => [...prev, msg]); say('جارٍ مشاركة موقعك');
  };
  const removePin = (id: string) => setPins(prev => prev.filter(pin => pin.id !== id));
  const showLayer = (value: 'standard' | 'satellite' | 'terrain') => { setLayer(value); };

  return (
    <main className="masar-app" dir="rtl" lang="ar">
      <div className="map-shell"><div ref={mapElement} className="map-map" aria-label="الخريطة" /></div>
      <header className="topbar panel">
        <div className="brand-mark"><Navigation size={21} strokeWidth={2.4} /></div>
        <div className="brand-copy"><strong>مسار</strong><span>رفيقك في الطريق</span></div>
        <div className={`net-badge ${online && connected ? 'is-online' : ''}`} data-testid="status-connection">
          <span className="live-dot" />{connected ? 'متصل' : online ? 'بانتظار الاتصال' : 'وضع عدم الاتصال — الخرائط المحفوظة'}
        </div>
        <button className="icon-button help-button" aria-label="حالة الاتصال" title="حالة الاتصال"><CircleHelp size={18} /></button>
      </header>

      <section className="side-panel panel" aria-label="الأشخاص القريبون">
        {selected ? (
          <div className="chat-view enter">
            <div className="chat-head">
              <button className="plain-icon" onClick={() => setSelected(null)} aria-label="العودة إلى الأشخاص"><ArrowDownLeft size={19} /></button>
              <div className="avatar chat-avatar" style={{ background: AVATAR_COLORS[selected.name.length % AVATAR_COLORS.length] }}><AvatarIcon name={selected.avatar} size={16} /></div>
              <div className="chat-person"><b>{selected.name}</b><span>{location ? `على بُعد ${arabicDistance(distanceKm(location, selected))}` : 'فعّل التتبع لحساب المسافة'}</span></div>
              <button className="share-coordinates-button" onClick={shareToChat} aria-label="مشاركة إحداثياتي الدقيقة" title="مشاركة إحداثياتي الدقيقة"><Crosshair size={16} /><span>مشاركة إحداثياتي الدقيقة</span></button>
              <button className="plain-icon" onClick={() => setSelected(null)} aria-label="إغلاق المحادثة"><X size={19} /></button>
            </div>
            {!online && <div className="offline-note"><WifiOff size={15} /> لا يمكن إرسال الرسائل دون اتصال. ستبقى المحادثات المحفوظة متاحة.</div>}
            <div className="message-list scroll-slim">
              {selectedMessages.length === 0 ? <div className="chat-empty"><MessageCircle size={28} /><b>لا توجد رسائل بعد</b><span>ابدأ محادثة قصيرة مع {selected.name}</span></div> : selectedMessages.map(message => {
                const mine = message.fromId === profile?.id;
                return <div key={message.id} className={`message-row ${mine ? 'mine' : ''}`}><div className="message-bubble">{message.text}{message.exactCoordinates && <div className="coord-chip"><MapPin size={13} /> {message.exactCoordinates.latitude.toFixed(5)}, {message.exactCoordinates.longitude.toFixed(5)}</div>}<time>{new Intl.DateTimeFormat('ar', { hour: '2-digit', minute: '2-digit' }).format(new Date(message.createdAt))}</time></div></div>;
              })}
            </div>
            <form className="composer" onSubmit={sendMessage}>
              <input aria-label="اكتب رسالة" placeholder={online ? 'اكتب رسالة...' : 'غير متاح دون اتصال'} value={draft} onChange={e => setDraft(e.target.value)} disabled={!online || !connected} data-testid="input-chat-message" />
              <button type="submit" className="send-button" disabled={!draft.trim() || !online || !connected} aria-label="إرسال الرسالة"><Send size={17} /></button>
            </form>
          </div>
        ) : (
          <>
            <div className="people-header">
              <div><div className="eyebrow">حولك الآن</div><h1>الأشخاص القريبون</h1></div>
              <span className="people-count"><Users size={14} />{people.length}</span>
            </div>
            <div className="self-card">
              <div className="avatar self-avatar" style={{ background: profile?.color ?? '#d5e7dd' }}><AvatarIcon name={profile?.avatar ?? 'compass'} size={18} /></div>
              <div className="self-copy"><b>{profile?.name || 'أنت'}</b><span><i className={tracking ? 'tiny-dot active' : 'tiny-dot'} />{tracking ? ghost ? 'تتبع مخفي' : 'تشارك موقعك' : 'التتبع متوقف'}</span></div>
              <button className={`ghost-toggle ${ghost ? 'selected' : ''}`} onClick={() => setGhost(v => !v)} aria-pressed={ghost} aria-label={ghost ? 'إيقاف وضع التخفي' : 'تفعيل وضع التخفي'} title="وضع التخفي">{ghost ? <EyeOff size={17} /> : <Eye size={17} />}<span>وضع التخفي</span></button>
            </div>
            <div className="people-scroll scroll-slim">
              {presenceQuery.isLoading ? <div className="people-skeleton">{[1, 2, 3].map(x => <div key={x} className="skeleton-row"><i /><span /></div>)}</div>
                : presenceQuery.isError ? <div className="empty-state error-state"><WifiOff size={23} /><b>تعذر تحميل الأشخاص</b><span>تحقق من الاتصال وحاول مجدداً</span><button onClick={() => void presenceQuery.refetch()}><RefreshCw size={14} /> إعادة المحاولة</button></div>
                  : people.length === 0 ? <div className="empty-state"><div className="empty-orbit"><Radio size={21} /></div><b>لا أحد قريب الآن</b><span>سيظهر هنا من يشارك موقعه حولك</span></div>
                    : people.map(person => {
                      const dist = location ? arabicDistance(distanceKm(location, person)) : 'فعّل الموقع';
                      return <button key={person.id} onClick={() => choosePerson(person)} className="person-row" data-testid={`person-${person.id}`}>
                        <div className="avatar person-avatar" style={{ background: AVATAR_COLORS[(person.name.length + person.id.length) % AVATAR_COLORS.length] }}><AvatarIcon name={person.avatar} size={17} /></div>
                        <div className="person-info"><b>{person.name}</b><span><span className="online-dot" />متصل الآن</span></div>
                        <div className="person-distance"><Navigation size={12} />{dist}</div><ChevronDown className="row-chevron" size={16} />
                      </button>;
                    })}
            </div>
            <div className="sidebar-bottom">
              <div className="coords-card">
                <div className="coords-heading"><span><Crosshair size={14} /> موقعك الحالي</span><button onClick={shareCoordinates} aria-label="نسخ الإحداثيات"><Copy size={14} /></button></div>
                {location ? <div className="coords-values"><span>{location.latitude.toFixed(5)}°</span><span>{location.longitude.toFixed(5)}°</span><div className="metrics"><span>ارتفاع <b>{location.altitude == null ? '—' : `${Math.round(location.altitude)} م`}</b></span><span>سرعة <b>{location.speed == null ? '—' : `${(location.speed * 3.6).toFixed(1)} كم/س`}</b></span></div></div>
                  : <div className="coords-placeholder">ابدأ التتبع لعرض إحداثياتك</div>}
              </div>
              <div className="sidebar-actions">
                <button className="sidebar-action" onClick={shareCoordinates}><Copy size={16} /><span>نسخ الإحداثيات</span></button>
                <button className="sidebar-action" onClick={toggleSimulation}><Activity size={16} /><span>{simulationTimer.current !== null ? 'إيقاف المحاكاة' : 'محاكاة الحركة'}</span></button>
              </div>
              <div className="storage-note"><Smartphone size={13} /> تُحفظ الأماكن والمحادثات على هذا الجهاز</div>
            </div>
          </>
        )}
      </section>

      <div className="map-tools">
        <div className="layer-switcher panel" role="group" aria-label="طبقة الخريطة">
          <button className={layer === 'satellite' ? 'active' : ''} onClick={() => showLayer('satellite')} aria-label="قمر صناعي" title="قمر صناعي"><Satellite size={16} /><span>قمر صناعي</span></button>
          <button className={layer === 'terrain' ? 'active' : ''} onClick={() => showLayer('terrain')} aria-label="تضاريس" title="تضاريس"><Mountain size={16} /><span>تضاريس</span></button>
          <button className={layer === 'standard' ? 'active' : ''} onClick={() => showLayer('standard')} aria-label="قياسي" title="قياسي"><MapIcon size={16} /><span>قياسي</span></button>
        </div>
        <button className="map-action locate-action" onClick={recenter} aria-label="موقعي الحالي" title="موقعي الحالي"><LocateFixed size={18} /><i className={`locate-pulse ${tracking && location ? 'active' : ''}`} /><span>موقعي الحالي</span></button>
        <button className={`map-action pin-action ${placingPin ? 'active' : ''}`} onClick={() => { setPlacingPin(v => !v); say(placingPin ? 'أُلغي تحديد الموقع' : 'المس الخريطة لإضافة مكان'); }} aria-label="حفظ مكان" title="حفظ مكان"><MapPin size={18} /><span>حفظ مكان</span></button>
      </div>
      <div className="map-footer">
        <div className="map-coord"><span className="map-compass"><Compass size={15} /></span><span>{location ? `${location.latitude.toFixed(4)}° ، ${location.longitude.toFixed(4)}°` : 'الرياض · المملكة العربية السعودية'}</span></div>
        <div className="map-scale">2 كم</div>
      </div>
      {placingPin && <div className="placing-banner">المس نقطة على الخريطة لحفظها <button onClick={() => setPlacingPin(false)} aria-label="إلغاء"><X size={15} /></button></div>}
      {pins.length > 0 && !selected && <div className="pins-drawer panel"><div className="pins-title"><MapPin size={15} /> أماكنك <span>{pins.length}</span></div><div className="pin-list scroll-slim">{pins.map(pin => <div key={pin.id} className="pin-item"><button onClick={() => mapRef.current?.map.flyTo({ center: [pin.longitude, pin.latitude], zoom: 15 })}>{pin.label}</button><button onClick={() => removePin(pin.id)} aria-label={`حذف ${pin.label}`}><Trash2 size={14} /></button></div>)}</div></div>}
      <button className="mobile-people-button" onClick={() => setMobilePeopleOpen(v => !v)} aria-expanded={mobilePeopleOpen}><Users size={17} /> الأشخاص القريبون <span>{people.length}</span></button>
      {mobilePeopleOpen && <div className="mobile-people-shade" onClick={() => setMobilePeopleOpen(false)} />}
      {notice && <div className="toast-notice" role="status">{notice}</div>}

      {!profile && profileLoaded && <div className="onboarding-backdrop">
        <section className="onboarding-card panel enter" aria-labelledby="welcome-title">
          <div className="onboard-mark"><Navigation size={23} /></div>
          <div className="eyebrow">مسار · رفيق الطريق</div>
          <h2 id="welcome-title">خلّنا نعرفك</h2>
          <p>اختر اسماً يظهر للأشخاص القريبين منك، ثم ابدأ مشاركة موقعك.</p>
          <label className="field-label" htmlFor="profile-name">الاسم الظاهر</label>
          <input id="profile-name" className="name-input" value={profileName} onChange={e => setProfileName(e.target.value)} placeholder="مثال: نورة" maxLength={28} autoComplete="name" data-testid="input-profile-name" />
          <div className="field-label avatar-label">اختر أيقونتك</div>
          <div className="avatar-palette">{AVATAR_OPTIONS.map((option, index) => <button key={option.id} aria-label={`اختيار أيقونة ${option.label}`} aria-pressed={profileAvatar === option.id} className={profileAvatar === option.id ? 'color-choice chosen' : 'color-choice'} style={{ background: AVATAR_COLORS[index] }} onClick={() => { setProfileAvatar(option.id); setProfileColor(AVATAR_COLORS[index]); }}><AvatarIcon name={option.id} size={16} />{profileAvatar === option.id && <i><Check size={12} /></i>}</button>)}</div>
          <div className="privacy-copy"><Eye size={15} /><span>موقعك لا يظهر إلا عند التتبع المباشر. يمكنك إخفاؤه بوضع الشبح.</span></div>
          {permissionError && <div className="permission-error" role="alert">{permissionError}</div>}
          <button className="start-button" disabled={!profileName.trim()} onClick={saveProfile} data-testid="button-start-tracking"><LocateFixed size={18} />ابدأ التتبع المباشر</button>
          <div className="onboard-foot"><Wifi size={13} /> يعمل مسار مع اتصال متقطع ويحفظ بياناتك محلياً</div>
        </section>
      </div>}
      {permissionError && profile && !tracking && <div className="permission-toast" role="alert">{permissionError}<button onClick={startTracking}>حاول مجدداً</button><button onClick={() => setPermissionError('')} aria-label="إغلاق"><X size={15} /></button></div>}
      {profile && <button className={`tracking-pill ${tracking ? 'tracking' : ''}`} onClick={tracking ? stopTracking : startTracking} aria-label={tracking ? 'إيقاف التتبع المباشر' : 'بدء التتبع المباشر'}>{tracking ? <><span className="live-dot" /> تتبع مباشر</> : <><LocateFixed size={15} /> بدء التتبع</>}</button>}
      <div className="health-indicator" aria-label={healthQuery.data?.status ?? 'جاري التحقق'}><span className={healthQuery.isError || !online ? 'health-dot down' : 'health-dot'} /></div>
    </main>
  );
}

function Router() {
  return <RoutedErrorBoundary><Switch><Route path="/" component={Home} /><Route component={NotFound} /></Switch></RoutedErrorBoundary>;
}
function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}
function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}
export default App;
