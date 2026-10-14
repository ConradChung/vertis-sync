'use client';
import { Canvas, useFrame } from '@react-three/fiber';
import { MeshTransmissionMaterial } from '@react-three/drei';
import { useRef } from 'react';
import * as THREE from 'three';
declare module 'react' { namespace JSX { interface IntrinsicElements { mesh: any; sphereGeometry: any; } } }
export default function Orb({state='idle',compact=false}:{state?:'idle'|'listening'|'thinking'|'acting'|'needs-approval',compact?:boolean}){
  const size=compact?42:122;
  return <div className={`orb-canvas ${state}`} style={{width:size,height:size}}><Canvas camera={{position:[0,0,3.2],fov:35}} dpr={[1,2]}><OrbMesh state={state}/></Canvas>{state==='acting'&&<i className="orbit-ring"/>}</div>
}
function OrbMesh({state}:{state:string}){const ref=useRef<THREE.Mesh>(null); useFrame(({clock})=>{if(ref.current){const t=clock.getElapsedTime();const amp=state==='listening'?Math.sin(t*5)*.07:state==='thinking'?Math.sin(t*1.3)*.04:Math.sin(t*.9)*.018;ref.current.scale.setScalar(1+amp);ref.current.rotation.y=t*.12;ref.current.rotation.x=Math.sin(t*.4)*.08;}}); return <mesh ref={ref}><sphereGeometry args={[1,64,64]}/><MeshTransmissionMaterial backside backsideThickness={0.4} thickness={0.7} roughness={0.12} transmission={1} ior={1.35} chromaticAberration={0.12} anisotropy={0.25} color={state==='needs-approval'?'#f59e0b':'#8b5cf6'}/></mesh>}
