import { useEffect, useState } from 'react'

import './App.css'
type Team = {
  id: number
  name: string
  created_at: string
}

function App() {
  const [teams, setTeams] = useState<Team[]>([])
  const loadTeams = () => {
    fetch('/api/teams')
      .then((response) => response.json())
      .then((data) => {
        console.log('Teams from API:', data)
        setTeams(data)
      })
  }
  useEffect(() => {
    console.log('Creating TeamBeacon EventSource')

    loadTeams()


    const eventSource = new EventSource('/api/events')
    eventSource.onopen = () => {
      console.log('SSE OPEN')
    }

    eventSource.onerror = (event) => {
      console.log('SSE ERROR', eventSource.readyState, event)
    }
    eventSource.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)

        console.log('SSE event:', message)

        if (message.type === 'team.created') {
          loadTeams()
        }
      }
      catch (error) {
        console.error('Error parsing SSE event data:', error)
      }
    }
    return () => {
      console.log('Effect CLEANUP')

      eventSource.close()
    }
  }, [])

  return (
    <main>
      <h1>Team Beacon</h1>
      <h2>Teams</h2>
      <button type="button" onClick={loadTeams}>
        Refresh
      </button>
      {teams.length === 0 ? (
        <p>No teams yet.</p>
      ) : (
        <ul>
          {teams.map((team) => (
            <li key={team.id}>{team.name}</li>
          ))}
        </ul>
      )}
    </main>
  )
}

export default App
