import React,{useState,useRef,useMemo,useEffect,useId} from 'react';
import {Plus,Minus,LocateFixed,RotateCcw,RefreshCw,ExternalLink,MapPin,AlertTriangle} from 'lucide-react';
import geography from '../shared/seongsu-geography.json';
import {WIDTH,HEIGHT,project as projectPoint,geometryPath,cameraTransform,zoomCamera,panCamera,constrainCamera,metresInView,mercator,unproject,center,BASE_SCALE} from './geography.mjs';
import './map.css';
const features=geography.features;
const roads=features.filter(f=>f.type==='road'),buildings=features.filter(f=>f.type==='building');
const stations=features.filter(f=>f.type==='station'&&f.kind==='station');
const areas=(type)=>{const groups=new Map();for(const f of features.filter(f=>f.type===type)){const id=f.parentId||f.id;groups.set(id,(groups.get(id)||'')+geometryPath(f.coordinates,true));}return [...groups].map(([id,d])=>({id,d}));};
const parks=areas('park'),water=areas('water');
const widthFor=k=>({motorway:8,trunk:7,primary:6,secondary:5,tertiary:4,residential:3,service:2,footway:1})[k]||2;
// The OSM snapshot has thousands of ways. Keep their SVG nodes stable while
// a pointer drag only changes the parent camera transform.
const waterPaths=water.map(f=><path key={f.id} d={f.d} fill="#cee1e4" fillRule="evenodd"/>);
const parkPaths=parks.map(f=><path key={f.id} d={f.d} fill="#dce4d2" fillRule="evenodd"/>);
const buildingPaths=buildings.map(f=><path key={f.id} d={geometryPath(f.coordinates,true)} fill="#d5d8d3" stroke="#c9cec6" strokeWidth=".3"/>);
const roadPaths=roads.map(f=><path key={f.id} d={geometryPath(f.coordinates)} fill="none" stroke="#fff" strokeWidth={widthFor(f.kind)} strokeLinejoin="round" strokeLinecap="round"/>);
const railPaths=features.filter(f=>f.type==='rail').map(f=><path key={f.id} d={geometryPath(f.coordinates)} fill="none" stroke="#85947a" strokeWidth="1.8" strokeDasharray="4 2"/>);
const roadNames=[...new Map(roads.filter(f=>f.name&&!['footway','path','service','steps'].includes(f.kind)).map(f=>[f.name,f])).values()].slice(0,23);
const original=[...mercator(center)];
const [west,south,east,north]=geography.source.bbox;
const corner=projectPoint([west,north]),opposite=projectPoint([east,south]);
export function mapContextForPosition(project){
 const context=project.mapContext;
 const validPlace=place=>place&&typeof place.id==='string'&&/^((node|way|relation)\/\d+)$/.test(place.id)&&typeof place.name==='string'&&Array.isArray(place.coordinates)&&place.coordinates.length===2&&place.coordinates.every(Number.isFinite)&&Math.abs(place.coordinates[0])<=180&&Math.abs(place.coordinates[1])<=85&&Number.isFinite(place.distance)&&place.distance>=0;
 return context?.schemaVersion===1&&context.source?.provider==='Overpass API'&&/^[a-f0-9]{64}$/.test(context.source?.querySha256||'')&&Number.isFinite(Date.parse(context.source?.osmBaseTimestamp))&&Array.isArray(context.coordinate)&&context.coordinate.length===2&&context.coordinate.every(Number.isFinite)&&Math.abs(context.coordinate[0]-Number(project.brief.lng))<=.000001&&Math.abs(context.coordinate[1]-Number(project.brief.lat))<=.000001&&context.longitude===context.coordinate[0]&&context.latitude===context.coordinate[1]&&Array.isArray(context.facilities)&&context.facilities.every(validPlace)&&Array.isArray(context.stations)&&context.stations.every(validPlace)&&Number.isFinite(Date.parse(context.collectedAt))&&Number.isInteger(context.radiusMeters)&&context.radiusMeters>=100&&context.radiusMeters<=1000?context:null;
}
const collected=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('ko-KR',{timeZoneName:'short'}):'수집 시점 미기록';
export function mapCollectionStatus(context,now=Date.now()){
 const expiry=Date.parse(context?.cache?.expiresAt);
 const collectedAt=Date.parse(context?.collectedAt);
 const until=Number.isFinite(expiry)?expiry:collectedAt+24*60*60*1000;
 if(Number.isFinite(until)&&now>=until)return '이전 조회 저장본 · 새 조회 권장';
 return context?.cache?.hit?'24시간 캐시':'사용자 요청 수집';
}
const category={cafe:'카페',restaurant:'음식점',theatre:'공연장',arts_centre:'문화시설',library:'도서관',museum:'박물관',gallery:'갤러리',station:'역'};
export default function MarketMap({project,onLocationChange,onRefresh,pending=false}){
 const [camera,setCamera]=useState({scale:1,x:0,y:0}),[layer,setLayer]=useState('radius'),[showBuildings,setBuildings]=useState(true),[labels,setLabels]=useState(true),[moving,setMoving]=useState(false);
 const [inputs,setInputs]=useState({latitude:project.brief.lat,longitude:project.brief.lng,radiusMeters:project.mapContext?.radiusMeters||500}),[refreshing,setRefreshing]=useState(false),[failure,setFailure]=useState(''),[showAll,setShowAll]=useState(false);
 const clipId=useId().replaceAll(':',''),busy=Boolean(pending)||refreshing,context=mapContextForPosition(project),radius=context?.radiusMeters||500;
 useEffect(()=>{setInputs({latitude:project.brief.lat,longitude:project.brief.lng,radiusMeters:project.mapContext?.radiusMeters||500});},[project.brief.lat,project.brief.lng,project.mapContext?.radiusMeters]);
 useEffect(()=>{if(context){setLayer('places');setShowAll(false);}},[context?.collectedAt]);
 const pointer=useRef(null),svg=useRef(null);
 const coordinate=[project.brief.lng,project.brief.lat],point=projectPoint(coordinate);
 const inBounds=coordinate[0]>=west&&coordinate[0]<=east&&coordinate[1]>=south&&coordinate[1]<=north;
 const poi=useMemo(()=>(context?context.facilities.map(f=>({...f,coordinates:[f.coordinates]})):features.filter(f=>f.type==='poi')).map(f=>({f,p:projectPoint(f.coordinates[0])})).sort((a,b)=>((a.p[0]-point[0])**2+(a.p[1]-point[1])**2)-((b.p[0]-point[0])**2+(b.p[1]-point[1])**2)).slice(0,80),[coordinate[0],coordinate[1],context]);
 const shownStations=context?context.stations.filter(f=>Array.isArray(f.coordinates)).map(f=>({...f,coordinates:[f.coordinates]})):stations;
 async function refresh(e){e.preventDefault();if(busy||typeof onRefresh!=='function')return;setRefreshing(true);setFailure('');try{const result=await onRefresh({latitude:Number(inputs.latitude),longitude:Number(inputs.longitude),radiusMeters:Number(inputs.radiusMeters)});if(!result)setFailure('조회 또는 저장에 실패했습니다. 아래 자료는 새 조회 결과로 바뀌지 않았습니다.');}catch(error){setFailure(error?.message||'조회에 실패했습니다. 예시 데이터로 대체하지 않았습니다.');}finally{setRefreshing(false);}}
 function start(e){if(e.button!==0)return;pointer.current={id:e.pointerId,x:e.clientX,y:e.clientY,camera};e.currentTarget.setPointerCapture(e.pointerId);setMoving(true);}
 function move(e){const p=pointer.current;if(!p||p.id!==e.pointerId)return;const b=svg.current.getBoundingClientRect();setCamera(panCamera(p.camera,(e.clientX-p.x)*WIDTH/b.width,(e.clientY-p.y)*HEIGHT/b.height));}
 function end(e){if(pointer.current?.id===e.pointerId){pointer.current=null;setMoving(false);if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}}
 function choose(e){if(busy)return;const b=svg.current.getBoundingClientRect(),x=(e.clientX-b.left)*WIDTH/b.width,y=(e.clientY-b.top)*HEIGHT/b.height;const world=[(x-WIDTH/2)/camera.scale+WIDTH/2+camera.x,(y-HEIGHT/2)/camera.scale+HEIGHT/2+camera.y];const [lng,lat]=unproject([original[0]+(world[0]-WIDTH/2)/BASE_SCALE,original[1]-(world[1]-HEIGHT/2)/BASE_SCALE]);if(lng>=west&&lng<=east&&lat>=south&&lat<=north)onLocationChange?.({lng:+lng.toFixed(6),lat:+lat.toFixed(6)});}
 function key(e){const d={ArrowLeft:[55,0],ArrowRight:[-55,0],ArrowUp:[0,55],ArrowDown:[0,-55]}[e.key];if(d){e.preventDefault();setCamera(c=>panCamera(c,...d));}else if(e.key==='+'||e.key==='='){e.preventDefault();setCamera(c=>zoomCamera(c,1));}else if(e.key==='-'){e.preventDefault();setCamera(c=>zoomCamera(c,-1));}}
 return <section className="market-map-component">
  <div className="map-topline"><div><small>OPENSTREETMAP · SOURCE-AWARE</small><h3>실제 좌표와 주변 시설</h3></div><span>{context?`${radius}m 시설 조회 저장됨`:'배경: 성수동 저장 지도'}</span></div>
  <form className="map-coordinate-form" onSubmit={refresh}><fieldset disabled={busy}><legend>조회 좌표 직접 지정</legend><label>위도<input aria-label="조회 위도" type="number" step="any" min="-85" max="85" required value={inputs.latitude} onChange={e=>setInputs(v=>({...v,latitude:e.target.value}))}/></label><label>경도<input aria-label="조회 경도" type="number" step="any" min="-180" max="180" required value={inputs.longitude} onChange={e=>setInputs(v=>({...v,longitude:e.target.value}))}/></label><label>반경<select aria-label="시설 조회 반경" value={inputs.radiusMeters} onChange={e=>setInputs(v=>({...v,radiusMeters:e.target.value}))}><option value="250">250m</option><option value="500">500m</option><option value="1000">1,000m</option></select></label><button type="submit" disabled={busy||typeof onRefresh!=='function'}><RefreshCw size={14}/>{refreshing?'조회 중…':'이 좌표의 시설 조회'}</button></fieldset><p>버튼을 누르면 좌표만 공공 Overpass API로 전송합니다. 장소 이름은 주소 검색이 아니며 좌표를 자동 변경하지 않습니다.</p>{typeof onRefresh!=='function'&&<p>현재 화면에는 새 시설 조회 연결이 없습니다.</p>}</form>
  {failure&&<div className="map-refresh-error" role="alert"><AlertTriangle size={15}/><span>{failure}</span></div>}
  {!inBounds&&<div className="map-base-unavailable"><MapPin size={24}/><p>이 좌표의 배경지도는 포함되어 있지 않습니다.</p><small>성수동 배경을 다른 장소처럼 표시하지 않습니다. 시설 조회 결과는 아래 목록과 OSM 원본 링크에서 확인하세요.</small><a href={`https://www.openstreetmap.org/?mlat=${coordinate[1]}&mlon=${coordinate[0]}#map=17/${coordinate[1]}/${coordinate[0]}`} target="_blank" rel="noreferrer">OSM에서 선택 위치 보기 <ExternalLink size={12}/></a></div>}
  <div className={`live-geographic-map ${moving?'dragging':''}`} hidden={!inBounds}>
   <svg ref={svg} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} tabIndex="0" role="group" aria-label="성수동 실제 지도. 확대 후 이동. 더블 클릭으로 분석 위치 선택." onKeyDown={key} onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onDoubleClick={choose}>
    <defs><clipPath id={clipId}><rect x={corner[0]} y={corner[1]} width={opposite[0]-corner[0]} height={opposite[1]-corner[1]}/></clipPath></defs>
    <rect width={WIDTH} height={HEIGHT} fill="#eef0ed"/>
    <g transform={cameraTransform(camera)} clipPath={`url(#${clipId})`}>
     {waterPaths}
     {parkPaths}
     {showBuildings&&buildingPaths}
     {roadPaths}
     {railPaths}
     {layer==='radius'&&inBounds&&[radius*.3,radius*.6,radius].map(r=><circle key={r} cx={point[0]} cy={point[1]} r={metresInView(r,{scale:1})} fill={r===radius?'#76b900':'none'} fillOpacity=".07" stroke="#76a542" strokeWidth="1" strokeDasharray="4 4"/>)}
     {labels&&roadNames.map(f=>{const p=projectPoint(f.coordinates[Math.floor(f.coordinates.length/2)]);return <text key={f.id} x={p[0]} y={p[1]} textAnchor="middle" fontSize={9/camera.scale} className="map-label">{f.name}</text>})}
     {layer==='places'&&poi.map(({f,p},i)=><g key={f.id} transform={`translate(${p[0]} ${p[1]}) scale(${1/camera.scale})`}><title>{f.name} · OSM 등록 시설</title><circle r="3" fill="#8a9b73" stroke="#fff"/>{i<15&&<text x="6" y="3" className="map-label" fontSize="9">{f.name}</text>}</g>)}
     {shownStations.map(f=>{const p=projectPoint(f.coordinates[0]);return <g key={f.id} transform={`translate(${p[0]} ${p[1]}) scale(${1/camera.scale})`}><circle r="7" fill="#668452" stroke="#fff" strokeWidth="2"/><text fill="white" fontSize="8" textAnchor="middle" y="3">M</text>{labels&&<text x="11" y="4" className="map-label" fontSize="11">{f.name.endsWith('역')?f.name:`${f.name}역`}</text>}</g>})}
     {inBounds&&<g transform={`translate(${point[0]} ${point[1]}) scale(${1/camera.scale})`}><circle r="10" fill="#76b900" stroke="#fff" strokeWidth="3"/><circle r="3" fill="#fff"/><rect x="-56" y="17" width="112" height="23" rx="3" fill="#fff" stroke="#bdccad"/><text x="0" y="32" textAnchor="middle" fontSize="10" fill="#3a4735">현재 분석 위치</text></g>}
    </g>
    <g transform="translate(18 556)"><path d={`M0 -5V0H${metresInView(200,camera)}V-5`} fill="none" stroke="#46543b"/><text y="13" fontSize="9" fill="#46543b">200m · {camera.scale.toFixed(1)}×</text></g>
   </svg>
   <div className="map-button-stack"><button aria-label="지도 확대" onClick={()=>setCamera(c=>zoomCamera(c,1))}><Plus size={16}/></button><button aria-label="지도 축소" onClick={()=>setCamera(c=>zoomCamera(c,-1))}><Minus size={16}/></button><button aria-label="선택 위치로 이동" disabled={!inBounds} onClick={()=>setCamera(constrainCamera({scale:2,x:point[0]-WIDTH/2,y:point[1]-HEIGHT/2}))}><LocateFixed size={16}/></button><button aria-label="지도 초기화" onClick={()=>setCamera({scale:1,x:0,y:0})}><RotateCcw size={16}/></button></div>
   <div className="map-copyright"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a> · <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noreferrer">ODbL</a></div>
  </div>
  <div className="map-options" hidden={!inBounds}><button className={layer==='radius'?'selected':''} onClick={()=>setLayer('radius')}>거리 반경</button><button className={layer==='places'?'selected':''} onClick={()=>setLayer('places')}>{context?'조회된 시설':'스냅샷 시설'}</button><label><input type="checkbox" checked={showBuildings} onChange={e=>setBuildings(e.target.checked)}/>건물</label><label><input type="checkbox" checked={labels} onChange={e=>setLabels(e.target.checked)}/>지명</label></div>
  <div className="map-source-status"><span><b>배경</b> 실제 OSM 저장 스냅샷</span><span><b>시설</b> {context?`${mapCollectionStatus(context)} · ${context.facilities.length}개 객체`:'배경과 같은 과거 스냅샷 · 새 조회 전'}</span></div>
  <p className="map-note">{inBounds?'더블 클릭은 좌표만 저장 · 시설은 다시 조회 · 확대 후 드래그':''}<br/>직선거리이며 도보 경로·시간이 아닙니다. 시설 객체 수는 고유 사업장·유동인구·매출이 아니며 영업 여부는 미확인입니다.{context?' 지도에는 가까운 80개까지 표시하고 수집 범위 밖은 그리지 않습니다.':''}</p>
  <details className="map-provenance"><summary>출처 · 수집 시점 · 조회 범위</summary><dl><div><dt>배경 제공자</dt><dd>{geography.source.name}</dd></div><div><dt>배경 수집</dt><dd>{collected(geography.source.fetchedAt)}</dd></div><div><dt>배경 범위</dt><dd>경도 {west}–{east} · 위도 {south}–{north}</dd></div>{context&&<><div><dt>시설 제공자</dt><dd>{context.source.provider} · ODbL-1.0</dd></div><div><dt>시설 수집</dt><dd>{collected(context.collectedAt)}</dd></div><div><dt>OSM 원본 시점</dt><dd>{collected(context.source.osmBaseTimestamp)}</dd></div><div><dt>시설 조회 범위</dt><dd>{context.latitude}, {context.longitude} · {context.radiusMeters}m · 카페·음식점·문화시설·역 분류</dd></div><div><dt>완전성</dt><dd>{context.coverage?.meaning||'조회 분류의 OSM 응답이며 모든 사업장 목록이 아닙니다.'}</dd></div><div><dt>쿼리 해시</dt><dd><code>{context.source.querySha256}</code></dd></div></>}</dl><p>지도·원본 데이터: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>. 새 조회는 수동 요청만 수행하며 캐시·요청 간격·결과 크기를 제한합니다. <a href="https://dev.overpass-api.de/overpass-doc/en/preface/commons.html" target="_blank" rel="noreferrer">공공 Overpass 이용 정책</a></p></details>
  {context&&<details className="map-facility-list"><summary>조회한 시설 원본 확인 · {context.facilities.length}개 객체</summary>{context.facilities.length?<><ol>{context.facilities.slice(0,showAll?context.facilities.length:20).map(place=><li key={place.id}><div><a href={`https://www.openstreetmap.org/${place.id}`} target="_blank" rel="noreferrer">{place.name}<ExternalLink size={11}/></a><small>{category[place.kind]||place.kind} · {place.address||'OSM 주소 태그 없음'}{place.coordinateMethod==='osm-bounding-box-centre'?' · 면 객체 중심점':''}</small></div><span>직선 {place.distance}m</span></li>)}</ol>{context.facilities.length>20&&<button type="button" onClick={()=>setShowAll(v=>!v)}>{showAll?'20개만 보기':`${context.facilities.length}개 전체 목록`}</button>}</>:<p>요청한 반경·분류에서 반환된 OSM 객체가 없습니다. 실제 시설이 없다는 뜻은 아닙니다.</p>}</details>}
 </section>
}
