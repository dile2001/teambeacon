import { useEffect, useState } from 'react'

import './App.css'
type Team = {
  id: number
  name: string
  created_at: string
}

function App() {

  const [teams, setTeams] = useState<Team[]>([])
  const [token, setToken] = useState<string | null>(null)
  const [username, setUsername] = useState<string>('')
  const [password, setPassword] = useState<string>('')
  const [loginError, setLoginError] = useState<string | ''>('')
  const createTeam = async (name: string) => {
    const response = await fetch('/api/teams', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name }),
    })
    if (response.status === 401) {
      setToken(null)
      return
    }
    if (!response.ok) {
      console.log('Create team failed:', response.status)
      return
    }

    const team = await response.json()

    console.log('Team created:', team)

    loadTeams()
  }
  const loadTeams = () => {
    fetch('/api/teams')
      .then((response) => response.json())
      .then((data) => {
        console.log('Teams from API:', data)
        setTeams(data)
      })
  }
  const logout = () => {
    setToken(null)
    setUsername('')
    setPassword('')
  }
  const login = async () => {
    setLoginError('')
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username,
        password,
      }),
    })

    if (!response.ok) {
      if (response.status === 401) {
        setLoginError('Invalid username or password')
      } else {
        setLoginError('Unable to sign in. Please try again.')
      }
      return
    }

    const data = await response.json()

    setToken(data.token)

    console.log('Login successful')
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
  if (!token) {
    return (
      <main>
        <h1>TeamBeacon</h1>
        <h2>Sign in</h2>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            login()
          }}
        >
          <div>
            <label htmlFor="username">Username</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>

          <div>
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          {loginError && (
            <p role="alert">
              {loginError}
            </p>
          )}
          <button type="submit">Sign in</button>
        </form>
      </main>
    )
  }
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
      <button
        type="button"
        onClick={() => createTeam(`UI Team ${Date.now()}`)}
      >
        Create test team
      </button>
      <button type="button" onClick={logout}>
        Sign out
      </button>
    </main>
  )
}

export default App
