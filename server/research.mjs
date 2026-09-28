import geography from '../shared/seongsu-geography.json' with {type:'json'};
export function distanceMetres(a,b){const r=Math.PI/180,dl=(b[0]-a[0])*r,dp=(b[1]-a[1])*r,x=Math.sin(dp/2)**2+Math.cos(a[1]*r)*Math.cos(b[1]*r)*Math.sin(dl/2)**2;return 6371000*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));}
export function currentMapContext(project){
  const context=project.mapContext;
  if(!context||context.schemaVersion!==1||context.source?.provider!=='Overpass API'||!Array.isArray(context.coordinate)||context.coordinate.length!==2||!context.coordinate.every(Number.isFinite)||!Array.isArray(context.facilities)||!Array.isArray(context.stations)||!Number.isFinite(Date.parse(context.collectedAt))||!Number.isInteger(context.radiusMeters)||context.radiusMeters<100||context.radiusMeters>1000)return null;
  if(!Number.isFinite(Number(project.brief.lng))||!Number.isFinite(Number(project.brief.lat)))return null;
  if(Math.abs(context.coordinate[0]-Number(project.brief.lng))>0.000001||Math.abs(context.coordinate[1]-Number(project.brief.lat))>0.000001)return null;
  return context;
}
export function analyzeArea(project){
  const coordinate=[Number(project.brief.lng),Number(project.brief.lat)];
  const context=currentMapContext(project);
  const [w,s,e,n]=geography.source.bbox;
  const inBounds=coordinate[0]>=w&&coordinate[0]<=e&&coordinate[1]>=s&&coordinate[1]<=n;
  const radius=context?.radiusMeters||500, latDelta=radius/6371000*180/Math.PI, lngDelta=latDelta/Math.cos(coordinate[1]*Math.PI/180);
  const complete=coordinate[0]-lngDelta>=w&&coordinate[0]+lngDelta<=e&&coordinate[1]-latDelta>=s&&coordinate[1]+latDelta<=n;
  const intersects=coordinate[0]+lngDelta>=w&&coordinate[0]-lngDelta<=e&&coordinate[1]+latDelta>=s&&coordinate[1]-latDelta<=n;
  const edgeDistance=inBounds?Math.min(distanceMetres(coordinate,[w,coordinate[1]]),distanceMetres(coordinate,[e,coordinate[1]]),distanceMetres(coordinate,[coordinate[0],s]),distanceMetres(coordinate,[coordinate[0],n])):0;
  const coverage=context?.coverage||{status:complete?'full':intersects?'partial':'outside',complete,queryComplete:complete,realWorldComplete:false,radius,nearestEdgeMetres:Math.floor(edgeDistance),meaning:'저장된 성수동 범위 안의 선택된 OSM 분류. 실제 모든 사업장 목록이 아닙니다.'};
  const facilities=context?structuredClone(context.facilities):geography.features.filter(f=>f.type==='poi').map(f=>({id:f.id,name:f.name,kind:f.kind,coordinates:f.coordinates[0],distance:Math.round(distanceMetres(coordinate,f.coordinates[0])),osmUrl:`https://www.openstreetmap.org/${f.id}`})).filter(f=>f.distance<=radius).sort((a,b)=>a.distance-b.distance);
  const counts={};for(const p of facilities)counts[p.kind]=(counts[p.kind]||0)+1;
  const stations=context?structuredClone(context.stations):geography.features.filter(f=>f.type==='station'&&f.kind==='station').map(f=>({id:f.id,name:f.name,coordinates:f.coordinates[0],distance:Math.round(distanceMetres(coordinate,f.coordinates[0])),osmUrl:`https://www.openstreetmap.org/${f.id}`})).sort((a,b)=>a.distance-b.distance);
  const source=context?{...structuredClone(context.source),cache:context.cache||null}:{mode:'bundled-snapshot',name:'OpenStreetMap · 성수동 저장 스냅샷',provider:'Overpass API (저장 스냅샷)',url:'https://www.openstreetmap.org/copyright',endpoint:geography.source.url,license:'ODbL-1.0',attribution:geography.source.attribution,collectedAt:geography.source.fetchedAt,capturedAt:geography.source.fetchedAt,osmBaseTimestamp:geography.source.osmBaseTimestamp,bbox:geography.source.bbox,querySha256:geography.source.querySha256};
  const basis=context?`사용자 요청으로 수집한 Overpass 응답 · 수집 ${source.collectedAt}`:`실제 OSM 저장 스냅샷 · 수집 ${source.collectedAt} · 현재 네트워크 조회 아님`;
  const withinCoverage=context?coverage.queryComplete===true:complete;
  const accessComplete=context?coverage.queryComplete===true&&stations.length>0:complete&&stations[0]?.distance<=edgeDistance;
  const accessSummary=stations[0]?`수집된 역 중 가장 가까운 ${stations[0].name} · ${stations[0].distance}m${accessComplete?'':' · 범위 밖에 더 가까운 역이 있을 수 있음'}`:`수집된 역 중 반경 ${radius}m에 확인된 역이 없습니다. 실제 역의 부재를 뜻하지 않습니다.`;
  const area=project.space.width*project.space.depth;
  return {id:`research-${Date.now()}`,createdAt:new Date().toISOString(),inputRevision:project.inputRevision,coordinate,inBounds:context?true:inBounds,baseMapInBounds:inBounds,coverage,radius,source,
    tools:[
      {id:'market',name:'상권 지도',status:withinCoverage?'complete':'limited',basis,summary:withinCoverage?`반경 ${radius}m · 선택 분류의 OSM 등록 객체 ${facilities.length}개 (고유 사업장 수 아님)`:`반경 ${radius}m 일부 또는 전부가 수집 범위 밖입니다. 수집된 객체 ${facilities.length}개는 전체 수가 아닙니다.`,data:{count:facilities.length,counts,coverage,collectedAt:source.collectedAt}},
      {id:'audience',name:'관객 가정',status:'assumption',basis:'사용자 입력, 실측 인구 아님',summary:`${project.assumptions.visitors}명 / ${project.assumptions.durationMinutes}분`,data:{visitors:project.assumptions.visitors,peak:project.assumptions.arrivalPeak}},
      {id:'places',name:'주변 시설',status:withinCoverage?'complete':'limited',basis:`${basis} / 영업 여부 미확인`,summary:withinCoverage?'선택한 카페·음식점·문화시설 분류의 OSM 객체를 직선거리순으로 표시':'수집 범위와 겹치는 지역만 표시한 불완전한 시설 목록',data:facilities.slice(0,30)},
      {id:'access',name:'접근성',status:accessComplete?'complete':'limited',basis:'Haversine 직선거리 / 실제 도보 경로·소요 시간 아님 / 조회된 역만 비교',summary:accessSummary,data:stations},
      {id:'weather',name:'날씨·일정',status:'unavailable',basis:'공식 예보·행사 일정 소스 미연결',summary:'실제 날씨·행사 일정을 확인할 데이터 연결이 필요합니다.',data:null},
      {id:'budget',name:'운영 예산',status:'assumption',basis:'사용자 예산 / 견적 아님',summary:`예산 ${project.assumptions.budget.toLocaleString()}원 · 면적 ${area}m²`,data:{budget:project.assumptions.budget,area,staff:project.space.staff}},
      {id:'experiment',name:'실험 설계',status:'complete',basis:'실행 설정',summary:`16안 × ${project.assumptions.replications}회 · 동일 난수 seed ${project.assumptions.seed}`,data:{seed:project.assumptions.seed,replications:project.assumptions.replications}},
      {id:'crm',name:'CRM 구조',status:'complete',basis:'프로젝트 상태 / 로컬 DB',summary:project.crm.deployment?'승인된 운영 패키지 적용됨':'안 승인 후 구역·슬롯·참가자·동의·업무 생성',data:{deployed:Boolean(project.crm.deployment),people:project.crm.people.length,tasks:project.crm.tasks.filter(t=>t.status!=='done').length}}
    ],facilities,stations,warning:`${context?'공공 API의 선택 분류 응답이며 전체 사업장 목록은 아닙니다.':'현재 네트워크 조회가 아닌 실제 지리 스냅샷입니다.'} 시설 객체 수는 유동인구나 매출 예측이 아닙니다. 같은 장소의 중복 객체가 있을 수 있으며 근접 시설은 직접 경쟁사라는 뜻이 아닙니다. 현장 접근성·수용·피난은 별도 검토하세요.`};
}
